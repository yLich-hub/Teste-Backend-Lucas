# Arquitetura e decisões

A ideia central: **o PostgreSQL é a fonte da verdade e o guardião das invariantes.** Tudo o que importa para dinheiro acontece numa única transação SQL, com a linha da wallet travada. Fila, broker e memória são otimizações; o banco garante que nada se duplica, nada fica negativo e nada se perde.

## 1. Fluxo de uma transação

```
HTTP (Idempotency-Key)  ─┐
                         ├─► ProcessWagerService.execute()   ← o MESMO use case
SQS (consumer)  ─────────┘
        │
        ▼  BEGIN
   [SQS] INSERT inbox (consumer, messageId) ON CONFLICT DO NOTHING ── já existia? → duplicata, fim
        │
   SELECT wallet ... FOR UPDATE            ← fila por wallet entre todas as instâncias
        │
   procura (provider, idempotency_key | external_id)
        ├── existe e hash igual   → replay (resultado original)
        ├── existe e hash difere  → 409 IDEMPOTENCY_CONFLICT
        └── não existe            → decideWager() (domínio puro)
                                       ├─ apply  → wallet.debit/credit → lançamento no ledger
                                       ├─ record → LOSS (sem saldo)
                                       ├─ reject → REJECTED + failureCode
                                       └─ wait   → PENDING_REFERENCE + próxima checagem
        │
   INSERT transação · UPDATE wallet (where version = ?) · INSERT ledger · INSERT outbox
        ▼  COMMIT   (constraint trigger confere saldo == último balance_after do ledger)
   [SQS] DeleteMessage (ack)  ← só depois do commit

Worker outbox:  claim (lease 30s, SKIP LOCKED) → publica no SQS sem transação aberta → published_at
Worker pending: transações PENDING_REFERENCE vencidas → mesmo fluxo (trava wallet, relê, decide)
```

## 2. Camadas

| Pasta | Responsabilidade | Depende de |
|---|---|---|
| `domain/` | Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, `decideWager` | nada (sem Nest, sem ORM) |
| `application/` | casos de uso, validação de contrato (zod), payload hash, erros de aplicação | domain, `Database`/`Tx` |
| `infrastructure/` | MikroORM/SQL, migrations, SQS, workers, logger, métricas | tudo acima |
| `http/` | controllers, filtro de erros, guard de auth | application |

Entidades seguem a regra do desafio: construtor `private` + factories (`create`/`open`/`from`/`rehydrate`). `rehydrate` reconstrói estado do banco sem revalidar transições.

**Trade-off consciente:** a camada de aplicação usa diretamente a classe `Tx` (unidade de trabalho com os repositórios). Não criei interfaces de repositório (ports) porque haveria uma única implementação e o ganho de testabilidade é pequeno — os testes de integração usam o banco real de qualquer forma, e a lógica de negócio que merece teste isolado já está pura no domínio (`decideWager`). O port que existe de fato é o `ProviderAuthGuard` (seção 12).

## 3. ORM e persistência

**MikroORM** (preferencial no desafio) é usado para: pool de conexões, `em.transactional()` (BEGIN/COMMIT/ROLLBACK com fork do EntityManager por transação) e **migrations versionadas e reversíveis** (`up`/`down`).

As queries são **SQL explícito** executado pelo `EntityManager` da transação (`em.execute`). Escolha deliberada: as partes críticas — `FOR UPDATE`, `FOR SHARE`, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO NOTHING`, `UPDATE ... WHERE version = ?` — ficam visíveis em uma linha, sem depender de change-tracking do Unit of Work. Assim o revisor vê exatamente qual lock é tomado e quando. O custo é escrever o mapeamento linha → domínio à mão (feito nos repositórios, sempre via `rehydrate`).

### Mapeamento do Money

- No banco: `numeric(20,2)` + coluna `currency char(3)`. Representação exata.
- Leitura: `balance::text` → string `"975.00"` → `Money.from(...)`. Nunca passa por `number`.
- Escrita: `money.toString()` (string decimal) como parâmetro.

## 4. Money

Internamente guarda **centavos em `bigint`** (inteiro de precisão arbitrária). Não há ponto flutuante em lugar nenhum: `0.10 + 0.20 = 0.30` exato. Escala fixa de 2 casas.

Entrada aceita somente `^(0|[1-9]\d{0,17})(\.\d{1,2})?$`, o que rejeita `NaN`, `Infinity`, notação científica, vazio, negativos, sinal `+`, vírgula e mais de 2 casas. **Não arredondamos**: `"10.005"` é rejeitado (arredondar dinheiro silenciosamente é pior que recusar). Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda; o desafio roda em BRL.

## 5. Concorrência

**Estratégia: lock pessimista por wallet** (`SELECT ... FOR UPDATE` na linha da wallet), dentro da mesma transação que lê o saldo, decide e grava.

Por que pessimista e não otimista:
- O caso de uso é "hot wallet": muitas operações na mesma wallet. Com optimistic locking, sob disputa a maioria das tentativas falha e precisa de retry — mais latência e mais código (retry limitado, backoff, idempotência do retry). Com o lock, as operações da mesma wallet simplesmente fazem fila no banco.
- O lock é **por linha**, não global: wallets diferentes rodam em paralelo (teste 3).
- Funciona igual com 1 ou N instâncias, porque o lock vive no PostgreSQL, não na memória do processo (teste 4: 3 processos).

Proteções adicionais:
- `SET LOCAL lock_timeout = 5s`: ninguém espera para sempre; estourou → erro transitório (HTTP 503 / retry no SQS) e métrica `wallet_lock_conflicts_total`.
- `UPDATE wallets ... WHERE id = ? AND version = ?`: segunda barreira (otimista). Com o lock nunca falha; se um dia alguém esquecer o lock, o update não sobrescreve em silêncio.
- `CHECK (balance >= 0)` e o constraint trigger saldo == ledger: mesmo um bug de aplicação não consegue commitar estado inválido.

Ordem de locks (evita deadlock): inbox (índice único) → wallet → linhas da transação. O worker de referências pendentes segue a mesma ordem: trava a wallet e só então relê a transação.

**Cenário obrigatório (100.00 e duas apostas de 80.00):** a primeira trava a wallet, debita, commita. A segunda estava esperando o lock; quando o recebe, lê saldo 20.00 e é rejeitada com `INSUFFICIENT_FUNDS`. Resultado: 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito.

## 6. Idempotência

- Fonte da verdade: header `Idempotency-Key` (HTTP) / `data.idempotencyKey` (SQS). Default recomendado `"{providerId}:{externalTransactionId}"`.
- **Persistente**: constraints `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Nenhum cache em memória.
- Como a busca acontece **depois** do lock da wallet, não existe corrida entre "procurar" e "inserir" para a mesma wallet. Se a mesma key for usada ao mesmo tempo em wallets diferentes, o índice único barra a segunda, que vira `IDEMPOTENCY_CONFLICT`.
- **payloadHash** = `sha256(JSON canônico)` dos campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`. JSON canônico = chaves ordenadas em todos os níveis, sem espaços, campos ausentes omitidos. O `amount` é normalizado antes (`"25"` → `"25.00"`). Header, `messageId`, `occurredAt` e outros metadados de transporte **não** entram.
- Mesma key + mesmo hash → replay: mesma resposta, com o **saldo observado naquele momento** (coluna `balance_after` da transação) e `idempotentReplay: true`.
- Mesma key (ou mesmo `externalTransactionId`) + hash diferente → `409 IDEMPOTENCY_CONFLICT`, nada é alterado.
- **SQS**: além disso, o inbox `(consumer_name, message_id)` deduplica a *mensagem*. O `messageId` usado é o do envelope de negócio (não o `MessageId` técnico do SQS), porque o produtor pode reenviar a mesma mensagem lógica com outro id técnico. Mesmo `messageId` com conteúdo diferente → `INBOX_PAYLOAD_MISMATCH` → DLQ.

## 7. Regras de negócio e interpretações

Implementadas em `domain/wager-rules.ts` (`decideWager`, função pura), nesta ordem:

1. moeda da transação ≠ moeda da wallet → `CURRENCY_MISMATCH`; player ≠ dono da wallet → `PLAYER_MISMATCH`.
2. Se há referência (`(providerId, referenceExternalTransactionId)`):
   - não existe → `PENDING_REFERENCE`;
   - outra wallet/player/moeda/rodada → `REFERENCE_MISMATCH`;
   - kind incompatível (REFUND→BET; ROLLBACK→BET|WIN|REFUND; WIN/LOSS→BET) → `INVALID_REFERENCE_KIND`;
   - referência ainda pendente → também espera; referência REJECTED/FAILED → `REFERENCE_NOT_PROCESSED`;
   - reversão com valor diferente → `AMOUNT_MISMATCH`; já revertida → `ALREADY_REVERSED`.
3. LOSS → PROCESSED sem mover saldo e sem lançamento.
4. Débito maior que o saldo → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_INSUFFICIENT_FUNDS` (ROLLBACK de crédito).

Interpretações adotadas:
- **Uma transação só pode ser revertida uma vez, por qualquer tipo de reversão.** O README fala em "pelo mesmo tipo de operação"; adotei a regra mais estrita porque uma BET com REFUND *e* ROLLBACK creditaria o jogador duas vezes. Garantido no schema por índice único parcial em `reference_transaction_id` (`status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`).
- WIN e LOSS **podem** referenciar a BET da rodada (opcional). BET e OPENING não aceitam referência.
- Valor zero só é aceito em LOSS; os demais exigem valor > 0.
- `OPENING` não é aceito pela API nem pela fila (o schema de entrada não tem esse kind).
- Wallet inexistente: não há onde registrar a transação (FK), então responde `404 WALLET_NOT_FOUND` / DLQ, sem persistir.
- O status `PENDING` existe só em memória: a decisão acontece na mesma transação em que a linha é criada.

## 8. Estados da transação

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
PROCESSED, REJECTED, FAILED: terminais
```

Transicionar um estado terminal lança `InvalidTransactionStateError` (erro de programação). No banco, um trigger impede UPDATE de linha terminal e qualquer DELETE.

## 9. Taxonomia de falhas

| Código | Status | Significado | Reenviar? |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo | só com saldo novo (nova transação) |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | ROLLBACK de crédito deixaria saldo negativo | não; exige ação operacional |
| `CURRENCY_MISMATCH` / `PLAYER_MISMATCH` | REJECTED | operação não pertence à wallet | não |
| `REFERENCE_NOT_FOUND` | REJECTED | a referência não chegou dentro do limite | não |
| `REFERENCE_MISMATCH` | REJECTED | referência de outro contexto | não |
| `INVALID_REFERENCE_KIND` | REJECTED | ex.: REFUND de um WIN | não |
| `REFERENCE_NOT_PROCESSED` | REJECTED | referência REJECTED/FAILED | não |
| `AMOUNT_MISMATCH` | REJECTED | reversão parcial (fora de escopo) | não |
| `ALREADY_REVERSED` | REJECTED | referência já revertida | não |
| `PROCESSING_ERROR` | FAILED | erro permanente inesperado ao reprocessar | não; investigar |
| `VALIDATION_ERROR` | HTTP 400 | payload inválido | corrigir |
| `IDEMPOTENCY_CONFLICT` | HTTP 409 | key reutilizada com outro payload | não |
| `SERVICE_UNAVAILABLE` | HTTP 503 | transitório | sim, mesma key |

O mapeamento HTTP completo está no README e em `http/error.filter.ts` — o mesmo para todos os endpoints.

## 10. Referências fora de ordem

- Transação entra em `PENDING_REFERENCE` com `next_reference_check_at` e evento `WagerTransactionPendingReference`.
- Worker agendado (`PendingReferenceWorker`, a cada 1s) pega as vencidas e reprocessa pelo mesmo caminho (trava wallet, relê o status, decide).
- **Backoff exponencial**: 1s, 2s, 4s … teto 5 min, **10 tentativas (~17 min no total)**. Justificativa: provedores costumam entregar a referência em segundos; 17 minutos cobrem atrasos de fila e reinícios sem deixar o jogador sem resposta por horas. Configurável (`ReferenceRetryPolicy`).
- Esgotado o limite: `REJECTED` / `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- Várias instâncias podem rodar o worker: a releitura sob lock e a checagem de `next_reference_check_at` impedem processamento duplo.

## 11. SQS

Consumidor (`WagerQueueConsumer`):
- **ack só depois do commit** (DeleteMessage após `execute` retornar).
- Classificação:
  - sucesso, REJECTED, PENDING_REFERENCE, duplicata → **ack** (decisão de negócio é terminal);
  - payload inválido, conflito de idempotência, wallet inexistente, mismatch no inbox → **DLQ imediata** (reenviar igual não resolve);
  - transitório/desconhecido → **retry**: `ChangeMessageVisibility` com backoff 2s, 4s, 8s…; ao atingir `SQS_MAX_RECEIVES` (5) → DLQ com atributo `failureReason`.
- RedrivePolicy da fila (`maxReceiveCount = max + 1`) é rede de segurança: se o processo morrer repetidamente no meio da mesma mensagem, o próprio SQS a move para a DLQ.
- **SIGTERM**: `enableShutdownHooks()` → `beforeApplicationShutdown` para de buscar mensagens, cancela o long-poll e espera as mensagens em andamento concluírem (commit + ack). Só então as conexões são fechadas. Mensagens não confirmadas voltam a ficar visíveis sozinhas.
- **Crash depois do commit e antes do ack**: a mensagem volta; o inbox já tem o `messageId` → duplicata → ack, sem efeito.
- FIFO: `MessageGroupId = walletId` dá ordem por wallet como otimização. A correção não depende disso (requisito 3).

## 12. Transactional Outbox

- Eventos são gravados na tabela `outbox_messages` **na mesma transação** da alteração financeira. Sem commit, sem evento; nada é publicado antes do commit.
- `OutboxPublisher` (a cada 500ms, em todas as instâncias) usa **lease** (migration `Migration20261114000000_outbox_lease`, colunas `locked_by`/`locked_until`):
  1. **claim** — um único `UPDATE ... SET locked_by = <instância>, locked_until = now() + 30s WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, que commita na hora. Publishers concorrentes pegam lotes disjuntos; só entram linhas sem aluguel ou com aluguel vencido.
  2. **publica** no SQS **sem transação aberta** no banco (nenhuma conexão fica presa esperando rede). O lote (até 100) é dividido em pedaços de 10 — o limite do `SendMessageBatch` — enviados **em paralelo**: 100 eventos viram 10 chamadas simultâneas em vez de 100 chamadas em fila.
  3. **release** — um único `UPDATE` marca `published_at` de todos os que deram certo e limpa o lease, com `WHERE locked_by = <instância>`: se o aluguel venceu e outra instância assumiu, o publisher atrasado não sobrescreve nada.
- Falha ao publicar (o pedaço inteiro, ou entradas recusadas individualmente no `Failed` do `SendMessageBatch`) → só esses eventos recebem `attempts++` e `next_attempt_at` com backoff (até 60s).
- Ordem: a fila `wallet-events` é standard e o envio é paralelo, então não há ordem garantida entre eventos. Quem precisa de ordem por wallet usa o `walletVersion` do `WalletBalanceChanged`.
- Processo morre depois de publicar e antes do release → quando o lease vence, outra instância publica de novo. **At-least-once**: pode haver duplicata, mas com o mesmo `eventId` (id da outbox = eventId), então o consumidor deduplica.
- `outbox_lag_seconds` é lido do banco a cada coleta de `/metrics`, então mostra o atraso real mesmo se nenhum publisher estiver rodando.
- Destino: fila `wallet-events` (atributos `eventType` e `eventId`).
- Eventos: `WagerTransactionProcessed` (inclusive LOSS e OPENING), `WagerTransactionRejected`, `WalletBalanceChanged` (somente com lançamento de ledger), `WagerTransactionPendingReference`. Classe abstrata `IntegrationEvent<T>` com `eventType`/`version` no tipo; `data` sempre com `MoneyProps` (string).
- Trade-off do lease: se uma publicação demorar mais que o lease (30s), outra instância pode publicar o mesmo evento em paralelo. É seguro (mesmo `eventId`) e o lease longo torna isso raro.

## 12.1 Teste de carga (`bun run test:load`)

`load/load-test.ts` gera carga HTTP contra as instâncias em execução (default: as 3 do compose, em round-robin) e grava um relatório em `load/results/`:

- usuários virtuais em loop fechado (default 32, por 30s);
- 50 carteiras com saldo alto + 1 *hot wallet* (saldo 500.00) recebendo 30% das requisições, para forçar disputa de lock e rejeições por saldo;
- mistura 70% BET / 20% WIN / 10% LOSS e 10% de reenvios idênticos (replay);
- relatório: ambiente, throughput, p50/p95/p99/máx, taxa de erro, distribuição de status, replays, conflitos de lock, espera média pelo lock, outbox lag e tempo para a outbox zerar, e reconciliação de todas as carteiras (falha se alguma estiver inconsistente).

Execuções de referência (relatórios em `load/results/`): docker compose completo — 3 instâncias, PostgreSQL 16 e LocalStack 3.8 no Docker Engine (WSL2), gerador de carga na mesma máquina (Ryzen 7 7800X3D, 16 CPUs, 31 GB), 32 usuários, 30s. A primeira execução revelou um gargalo na outbox; a segunda é depois da correção:

| Métrica | 1ª: publicação 1 a 1 | 2ª: `SendMessageBatch` em paralelo |
|---|---|---|
| Requisições / throughput | 30.247 · ~1.006 req/s | 33.100 · **~1.101 req/s** |
| Latência p50 / p95 / p99 / máx | 5,3 / 142,7 / 181,3 / 407,4 ms | **4,9 / 132,5 / 162,2 / 310,7 ms** |
| Taxa de erro (5xx + rede) | 0% | **0%** |
| Status | 200: 26.440 · 422: 3.807 | 200: 28.990 · 422: 4.110 |
| Replays idempotentes | 3.033 | 3.361 |
| Conflitos de lock / espera média | 0 / 29 ms | 0 / 27 ms |
| **Outbox lag ao fim / tempo para zerar** | 16,9 s / 35 s | **0,4 s / 1,1 s** |
| Carteiras inconsistentes | 0 de 51 | **0 de 51** |

Análise honesta:
- A cauda (p95/p99) vem da hot wallet: 30% do tráfego faz fila no lock de uma única linha. É o custo esperado do lock pessimista, e as demais carteiras seguem em paralelo (p50 de 5 ms).
- **O gargalo encontrado foi a publicação da outbox**, não a parte financeira: cada requisição gera 2–3 eventos e o publisher enviava um `SendMessage` por vez, então o lag crescia durante a carga. Com `SendMessageBatch` (10 por chamada), pedaços enviados em paralelo e um único `UPDATE` para marcar o lote, o publisher passou a acompanhar a carga (lag < 1s). Mesmo antes da correção não havia risco à consistência: os eventos ficam seguros na tabela até serem publicados.
- Tudo roda na mesma máquina (gerador, 3 apps, banco e emulador de SQS disputando CPU), então os números absolutos servem para comparação, não como capacidade de produção.

## 13. Garantias no schema (migration `Migration20261113000000_initial`)

| Garantia | Como |
|---|---|
| 1 wallet por player+moeda | `UNIQUE (player_id, currency)` |
| saldo não negativo | `CHECK (balance >= 0)` |
| idempotência | `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| 1 lançamento por transação por wallet | `UNIQUE (wallet_id, transaction_id)` |
| aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)`, `amount > 0` |
| ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| transação terminal imutável | trigger bloqueia mudança de PROCESSED/REJECTED/FAILED e DELETE |
| reversão única | índice único parcial em `reference_transaction_id` |
| saldo materializado == ledger | constraint trigger `DEFERRABLE INITIALLY DEFERRED`, checado no COMMIT |
| inbox | `PRIMARY KEY (consumer_name, message_id)` |
| REFUND/ROLLBACK com referência | `CHECK` |

Paginação do ledger: coluna `seq bigserial` + keyset (`seq > cursor`); o cursor é base64url opaco.

## 14. Observabilidade

- Logs JSON (uma linha por evento) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `status`, `failureCode`. **Sem valores monetários nem payloads**.
- `GET /metrics` (Prometheus): `wager_transactions_total{status,kind}`, `wager_duplicates_total{source}`, `wager_idempotency_conflicts_total`, `sqs_message_retries_total`, `sqs_messages_dead_lettered_total{reason}`, `wallet_lock_conflicts_total`, `wallet_lock_wait_seconds` (hot wallet), `outbox_lag_seconds`, `outbox_publish_failures_total`, `wager_processing_seconds{source}`, `pending_reference_retries_total`, `reconciliation_mismatches_total` + métricas default do processo.
- `GET /health/live` (processo) e `GET /health/ready` (PostgreSQL e SQS acessíveis; 503 caso contrário).
- Reconciliação: divergências são logadas como `error`, contadas em métrica e retornadas com `consistent: false` — nunca corrigidas silenciosamente.

## 15. Autenticação (não implementada — decisão)

Autenticação não pontua no desafio, então priorizei correção financeira e concorrência. O ponto de extensão está explícito em `src/http/auth.guard.ts` (`ProviderAuthGuard`, no-op aplicado aos controllers de negócio; health/metrics ficam abertos).

Desenho previsto: **Keycloak** (OIDC) no compose, um client por provedor de jogos com `client_credentials`. O guard valida o JWT (JWKS, `iss`, `aud`, `exp`) e exige que o `provider_id` do token seja igual ao `providerId` do corpo — um provedor não pode lançar transações em nome de outro. Mensagens da fila são canal interno confiável, mas continuam passando pelas mesmas validações de domínio (player/wallet/moeda).

## 16. Limitações e próximos passos

- O teste de carga mede um único cenário de mistura; não há rampa de carga nem teste de longa duração (*soak*).- A transação PENDING_REFERENCE é reprocessada pelo worker; não há "gatilho" imediato quando a referência chega (latência de até ~1s + backoff). Melhoria simples: ao processar uma transação, adiantar `next_reference_check_at` das pendentes que a referenciam.
- Ledger de partidas dobradas (opcional) não implementado: cada movimento tem um único lançamento por wallet.
- Wallet inexistente não gera registro auditável no banco (vai para a DLQ / 404).
- Rejeições de reversão por saldo (`REVERSAL_INSUFFICIENT_FUNDS`) exigem tratamento operacional fora do sistema.
