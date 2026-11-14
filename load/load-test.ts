/**
 * Teste de carga: `bun run test:load`
 *
 * Bate na API HTTP das instâncias em execução (default: as 3 do docker compose,
 * em round-robin) e gera um relatório em load/results/.
 *
 * Metodologia (ajustável por variável de ambiente):
 *  - LOAD_WALLETS carteiras com saldo alto + 1 "hot wallet" com saldo baixo;
 *  - LOAD_CONCURRENCY usuários virtuais, cada um em loop fechado (manda,
 *    espera a resposta, manda a próxima) durante LOAD_DURATION_S segundos;
 *  - mistura: 70% BET, 20% WIN, 10% LOSS; LOAD_HOT_SHARE das requisições vão
 *    para a hot wallet (disputa de lock + rejeições por saldo);
 *    LOAD_DUP_SHARE são reenvios idênticos de requisições anteriores (replay);
 *  - no fim: métricas Prometheus das instâncias, tempo para a outbox zerar e
 *    reconciliação de TODAS as carteiras (saldo == ledger).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const BASES = (env.LOAD_BASE_URLS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''));
const DURATION_S = Number(env.LOAD_DURATION_S ?? 30);
const CONCURRENCY = Number(env.LOAD_CONCURRENCY ?? 32);
const WALLETS = Number(env.LOAD_WALLETS ?? 50);
const HOT_SHARE = Number(env.LOAD_HOT_SHARE ?? 0.3);
const DUP_SHARE = Number(env.LOAD_DUP_SHARE ?? 0.1);
const OUTBOX_WAIT_S = Number(env.LOAD_OUTBOX_WAIT_S ?? 60);

type Wallet = { id: string; playerId: string };
type Sent = { key: string; body: Record<string, unknown> };
type Sample = { ms: number; status: number; replay: boolean };

let rr = 0;
const nextBase = () => BASES[rr++ % BASES.length]!;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${nextBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function createWallet(amount: string): Promise<Wallet> {
  const res = await post('/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`falha ao criar wallet: ${res.status} ${await res.text()}`);
  const w = (await res.json()) as Wallet;
  return { id: w.id, playerId: w.playerId };
}

function randomAmount(): string {
  const cents = 100 + Math.floor(Math.random() * 1900); // 1.00 .. 19.99
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function newRequest(wallet: Wallet): Sent {
  const r = Math.random();
  const kind = r < 0.7 ? 'BET' : r < 0.9 ? 'WIN' : 'LOSS';
  const externalTransactionId = `load-${randomUUID()}`;
  return {
    key: `provider-load:${externalTransactionId}`,
    body: {
      providerId: 'provider-load',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${Math.floor(Math.random() * 1000)}`,
      gameId: 'load-game',
      kind,
      money: { amount: randomAmount(), currency: 'BRL' },
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Soma uma métrica Prometheus (todas as séries) entre as instâncias. */
async function scrape(name: string, agg: 'sum' | 'max' = 'sum'): Promise<number | undefined> {
  const values: number[] = [];
  for (const base of BASES) {
    try {
      const text = await (await fetch(`${base}/metrics`)).text();
      const lines = text.split('\n').filter((l) => l.startsWith(name) && !l.startsWith('#'));
      const v = lines.reduce((acc, l) => acc + Number(l.split(' ').at(-1)), 0);
      if (lines.length) values.push(v);
    } catch {
      /* instância fora */
    }
  }
  if (!values.length) return undefined;
  return agg === 'max' ? Math.max(...values) : values.reduce((a, b) => a + b, 0);
}

async function main() {
  console.log(`alvos: ${BASES.join(', ')} | ${DURATION_S}s | ${CONCURRENCY} usuários virtuais`);
  for (const base of BASES) {
    const ok = await fetch(`${base}/health/live`).then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error(`instância ${base} não responde. Suba com: docker compose --profile app up -d --build`);
  }

  // ---- preparação
  const hot = await createWallet('500.00');
  const wallets = [hot];
  for (let i = 0; i < WALLETS; i++) wallets.push(await createWallet('1000000.00'));
  const lockConflictsBefore = (await scrape('wallet_lock_conflicts_total')) ?? 0;

  // ---- carga
  const samples: Sample[] = [];
  const sent: Sent[] = [];
  let networkErrors = 0;
  const started = performance.now();
  const deadline = started + DURATION_S * 1000;

  async function virtualUser() {
    while (performance.now() < deadline) {
      const dup = sent.length > 0 && Math.random() < DUP_SHARE;
      const req = dup
        ? sent[Math.floor(Math.random() * sent.length)]!
        : newRequest(Math.random() < HOT_SHARE ? hot : wallets[1 + Math.floor(Math.random() * WALLETS)]!);
      const t0 = performance.now();
      try {
        const res = await post('/wagering/transactions', req.body, { 'Idempotency-Key': req.key });
        const json = (await res.json().catch(() => ({}))) as { idempotentReplay?: boolean };
        samples.push({ ms: performance.now() - t0, status: res.status, replay: json.idempotentReplay === true });
        if (!dup && res.status < 500) sent.push(req);
      } catch {
        networkErrors++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, virtualUser));
  const elapsedS = (performance.now() - started) / 1000;

  // ---- outbox: quanto tempo para publicar tudo
  const lagAtEnd = await scrape('outbox_lag_seconds', 'max');
  const drainStart = performance.now();
  let drained = false;
  while ((performance.now() - drainStart) / 1000 < OUTBOX_WAIT_S) {
    const lag = await scrape('outbox_lag_seconds', 'max');
    if (lag === 0) {
      drained = true;
      break;
    }
    await Bun.sleep(1000);
  }
  const drainS = (performance.now() - drainStart) / 1000;

  // ---- consistência
  let inconsistent = 0;
  for (const w of wallets) {
    const rec = (await (await post(`/wallets/${w.id}/reconciliation`, {})).json()) as { consistent: boolean };
    if (!rec.consistent) inconsistent++;
  }
  const lockConflicts = ((await scrape('wallet_lock_conflicts_total')) ?? 0) - lockConflictsBefore;
  const lockWaitSum = await scrape('wallet_lock_wait_seconds_sum');
  const lockWaitCount = await scrape('wallet_lock_wait_seconds_count');

  // ---- relatório
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const total = samples.length + networkErrors;
  const errors = samples.filter((s) => s.status >= 500).length + networkErrors;
  const f = (n: number) => n.toFixed(1);

  const report = `# Resultado do teste de carga — ${new Date().toISOString()}

## Ambiente
- Máquina: ${cpus()[0]?.model ?? '?'} (${cpus().length} CPUs), ${(totalmem() / 2 ** 30).toFixed(1)} GB RAM, ${platform()} ${release()}
- Bun ${Bun.version}; instâncias alvo: ${BASES.length} (${BASES.join(', ')})
- Gerador de carga rodando na mesma máquina que app, PostgreSQL e SQS (os números competem por CPU)

## Metodologia
- ${CONCURRENCY} usuários virtuais em loop fechado por ${DURATION_S}s, round-robin entre as instâncias
- ${WALLETS} carteiras com saldo alto + 1 hot wallet (saldo 500.00) recebendo ${HOT_SHARE * 100}% das requisições
- Mistura: 70% BET, 20% WIN, 10% LOSS (valores 1.00–19.99); ${DUP_SHARE * 100}% reenvios idênticos (replay)

## Resultados
| Métrica | Valor |
|---|---|
| Requisições | ${total} em ${f(elapsedS)}s |
| Throughput | **${f(total / elapsedS)} req/s** |
| Latência p50 / p95 / p99 / máx | **${f(percentile(lat, 50))} / ${f(percentile(lat, 95))} / ${f(percentile(lat, 99))} / ${f(lat.at(-1) ?? 0)} ms** |
| Taxa de erro (5xx + rede) | **${f((errors / Math.max(total, 1)) * 100)}%** (${errors}) |
| Status HTTP | ${[...byStatus.entries()].sort().map(([s, n]) => `${s}: ${n}`).join(' · ')} |
| Replays idempotentes | ${samples.filter((s) => s.replay).length} |
| Conflitos de lock (timeout/deadlock) | ${lockConflicts} |
| Espera média pelo lock da wallet | ${lockWaitSum !== undefined && lockWaitCount ? f((lockWaitSum / lockWaitCount) * 1000) + ' ms' : 'n/d'} |
| Outbox lag ao fim da carga | ${lagAtEnd === undefined ? 'n/d' : f(lagAtEnd) + ' s'} |
| Tempo para a outbox zerar | ${drained ? f(drainS) + ' s' : `não zerou em ${OUTBOX_WAIT_S}s (worker de outbox/SQS desligado?)`} |
| Carteiras inconsistentes (saldo ≠ ledger) | **${inconsistent} de ${wallets.length}** |

422 = rejeição de negócio esperada (principalmente saldo insuficiente na hot wallet).
503 = falha transitória (ex.: lock_timeout), que o provedor reenviaria com a mesma key.
`;

  console.log(report);
  const dir = join(import.meta.dir, 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `load-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, report);
  console.log(`relatório salvo em ${file}`);
  if (inconsistent > 0) process.exit(1);
}

await main();
