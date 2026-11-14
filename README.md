# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS, mantendo saldo, ledger e eventos corretos mesmo com mensagens **duplicadas**, **fora de ordem** e **simultâneas**, em **várias instâncias**.

Stack: Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · MikroORM (transações + migrations) · AWS SQS (LocalStack) · Docker Compose.

As decisões técnicas estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Como rodar

Pré-requisitos: Docker e [Bun](https://bun.sh) 1.x.

```bash
bun install
docker compose up -d                          # PostgreSQL + LocalStack (SQS)
docker compose --profile app up -d --build    # migrations + 3 instâncias da app (portas 3001, 3002, 3003)
```

Sem Docker para a app (só a infra no Docker):

```bash
bun run migration:up
bun run start          # http://localhost:3000
```

### Variáveis de ambiente principais

| Variável | Default |
|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` |
| `WAGER_QUEUE_NAME` / `WAGER_DLQ_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` |
| `EVENTS_QUEUE_NAME` | `wallet-events` (destino da outbox) |
| `SQS_MAX_RECEIVES` | `5` tentativas antes da DLQ |
| `LOCK_TIMEOUT_MS` | `5000` (espera máxima pelo lock de uma wallet) |
| `WORKER_CONSUMER` / `WORKER_OUTBOX` / `WORKER_PENDING_REFERENCE` | `true` |

## Testes

```bash
docker compose up -d       # os testes usam PostgreSQL e SQS reais (banco separado: wagering_test)
bun run test:unit          # domínio: Money, Wallet, regras, idempotência
bun run test:integration   # schema/constraints, fluxos, HTTP, inbox/outbox/retry/DLQ
bun run test:concurrency   # 50x a mesma aposta, 100 vs 80+80, 3 processos, crash antes do ack...
bun run test               # tudo
```

Teste de carga (diferencial), com as 3 instâncias no ar:

```bash
docker compose --profile app up -d --build
bun run test:load          # relatório em load/results/ (ajuste com LOAD_DURATION_S, LOAD_CONCURRENCY...)
```

Metodologia e uma execução de referência estão em ARCHITECTURE.md, seção 12.1.

Todos os testes de integração terminam verificando a invariante `wallet.balance == saldo reconstruído pelo ledger` (via reconciliação).

| Cenário obrigatório (seção 13) | Onde |
|---|---|
| mesma aposta 50x em paralelo | `test/concurrency/concurrency.test.ts` (1) |
| saldo 100, duas apostas de 80 | `test/concurrency/concurrency.test.ts` (2) |
| wallets distintas em paralelo | `test/concurrency/concurrency.test.ts` (3) |
| ≥ 3 processos simultâneos | `test/concurrency/concurrency.test.ts` (4) — 3 processos Bun separados |
| worker morto depois do commit e antes do ack | `concurrency.test.ts` (5) e `test/integration/messaging.test.ts` (SQS real) |
| dois publishers na mesma outbox | `test/integration/outbox-lease.test.ts` (banco) e `messaging.test.ts` (SQS real) |
| ROLLBACK/REFUND antes da referência | `concurrency.test.ts` (7) e `wager-flow.test.ts` |
| reinício do serviço | `concurrency.test.ts` (8) |
| migrations e constraints | `test/integration/schema.test.ts` |
| retry e DLQ | `test/integration/messaging.test.ts` |

## API

| Método | Rota | Resposta |
|---|---|---|
| `POST` | `/wallets` | `201` · `409 WALLET_ALREADY_EXISTS` |
| `GET` | `/wallets/:walletId` | `200` · `404` |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | `200` (`nextCursor` opaco) |
| `POST` | `/wallets/:walletId/reconciliation` | `200` (`consistent: true/false`) |
| `POST` | `/wagering/transactions` (header `Idempotency-Key`) | ver tabela abaixo |
| `GET` | `/wagering/transactions/:transactionId` | `200` · `404` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | `200` · `404` |
| `GET` | `/health/live`, `/health/ready`, `/metrics` | sem autenticação |

Status HTTP de `POST /wagering/transactions` (iguais no replay):

| HTTP | Situação | O provedor deve |
|---|---|---|
| `200` | `PROCESSED` | nada |
| `202` | `PENDING_REFERENCE` (aceita, aguardando a referência) | consultar depois |
| `422` | `REJECTED` + `failureCode` | não reenviar igual |
| `400` | `VALIDATION_ERROR` (payload inválido) | corrigir o payload |
| `409` | `IDEMPOTENCY_CONFLICT` (mesma key, payload diferente) | não reenviar |
| `404` | `WALLET_NOT_FOUND` | corrigir o walletId |
| `503` | `SERVICE_UNAVAILABLE` (banco fora, lock timeout) + `Retry-After` | reenviar com a mesma key |

### Exemplo

```bash
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3002/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<ID>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# via fila:
bun run scripts/send-wager-message.ts <walletId> <playerId> BET 10.00
```

## LocalStack x MiniStack

O compose usa `localstack/localstack:3.8` (versão fixada, sem exigir token). Se a sua máquina exigir token, há duas saídas: definir `LOCALSTACK_AUTH_TOKEN` (conta Hobby gratuita) ou trocar a imagem por um emulador compatível na porta 4566 (ex.: MiniStack). A aplicação só precisa de um endpoint compatível com a API do SQS e cria as filas sozinha (`SQS_AUTO_CREATE=true`).

## Estrutura

```
src/
  domain/          regras puras (sem Nest/ORM): Money, Wallet, WagerTransaction, ledger, eventos, decideWager
  application/     casos de uso: ProcessWagerService (HTTP e SQS), CreateWallet, consultas/reconciliação
  infrastructure/  PostgreSQL (MikroORM + SQL), migrations, SQS, workers (outbox, referências pendentes), logs/métricas
  http/            controllers, mapeamento de erros, AuthGuard (ponto de extensão)
test/              unit, integration, concurrency
load/              teste de carga (bun run test:load)
```
