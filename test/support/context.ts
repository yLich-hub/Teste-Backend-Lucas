import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CreateWalletService } from '../../src/application/create-wallet.service';
import { ProcessWagerService } from '../../src/application/process-wager.service';
import { parseWagerCommand } from '../../src/application/wager-command';
import { WalletQueriesService } from '../../src/application/wallet-queries.service';
import { AppConfig, loadConfig } from '../../src/config';
import { ReferenceRetryPolicy } from '../../src/domain/wager-transaction';
import { Database } from '../../src/infrastructure/database/database';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { JsonLogger } from '../../src/infrastructure/observability/logger';
import { Metrics } from '../../src/infrastructure/observability/metrics';

/**
 * Infra REAL para os testes de integração/concorrência: PostgreSQL e SQS
 * (LocalStack/MiniStack) do docker-compose. Nada de mocks de banco ou fila.
 */
export const silentLogger = new JsonLogger((process.env.TEST_LOG_LEVEL as any) ?? 'error');

export interface TestContext {
  config: AppConfig;
  db: Database;
  metrics: Metrics;
  processWager: ProcessWagerService;
  createWallet: CreateWalletService;
  queries: WalletQueriesService;
  close(): Promise<void>;
}

export async function createContext(
  opts: { retryPolicy?: ReferenceRetryPolicy; clock?: () => Date } = {},
): Promise<TestContext> {
  const config = loadConfig();
  const db = await Database.connect({ url: config.databaseUrl, poolMax: 25, lockTimeoutMs: 10_000 });
  await db.orm.getMigrator().up();
  const metrics = new Metrics();
  return {
    config,
    db,
    metrics,
    processWager: new ProcessWagerService(db, metrics, silentLogger, opts.retryPolicy, opts.clock),
    createWallet: new CreateWalletService(db, silentLogger),
    queries: new WalletQueriesService(db, metrics, silentLogger),
    close: () => db.close(),
  };
}

export async function newWallet(ctx: TestContext, amount = '100.00', currency = 'BRL') {
  return ctx.createWallet.execute(
    { playerId: `player-${randomUUID()}`, initialBalance: { amount, currency } },
    'test',
  );
}

export function wagerBody(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

export function command(body: ReturnType<typeof wagerBody>, key = `${body.providerId}:${body.externalTransactionId}`) {
  return parseWagerCommand(body, key);
}

export async function submit(ctx: TestContext, body: ReturnType<typeof wagerBody>) {
  const outcome = await ctx.processWager.execute(command(body), { correlationId: 'test', source: 'http' });
  if (outcome.duplicateMessage) throw new Error('unexpected duplicate');
  return outcome;
}

/** Invariante final de TODOS os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectConsistent(ctx: TestContext, walletId: string) {
  const report = await ctx.queries.reconcile(walletId);
  expect(report.consistent).toBe(true);
  expect(report.difference.amount).toBe('0.00');
  return report;
}

export async function countRows(db: Database, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.query(`select count(*)::int as n from (${sql}) q`, params);
  return Number(row!.n);
}

// ------------------------------------------------------------------- SQS

/** Filas exclusivas por arquivo de teste para não competir com a app do compose. */
export async function createTestQueues(prefix: string, maxReceives = 3) {
  const config = loadConfig();
  const id = randomUUID().slice(0, 8);
  const queues = {
    wager: `t-${prefix}-${id}.fifo`,
    dlq: `t-${prefix}-${id}-dlq.fifo`,
    events: `t-${prefix}-${id}-events`,
  };
  const sqs = new SqsGateway(config.aws);
  await sqs.ensureQueues(queues, maxReceives, 2);
  return { sqs, queues };
}

type Drained = { body: string; attributes: Record<string, string> };

/**
 * Lê mensagens de uma fila (para asserts) até ter `expected` mensagens que
 * passem no filtro; depois faz uma leitura extra para pegar duplicatas.
 */
export async function drain(
  sqs: SqsGateway,
  queue: string,
  expected: number,
  timeoutMs = 15_000,
  filter: (m: Drained) => boolean = () => true,
): Promise<Drained[]> {
  const bodies: Drained[] = [];
  const deadline = Date.now() + timeoutMs;
  const readOnce = async () => {
    const msgs = await sqs.receive(queue, { max: 10, waitSeconds: 1 });
    for (const m of msgs) {
      const item = {
        body: m.Body ?? '',
        attributes: Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
        ),
      };
      if (filter(item)) bodies.push(item);
      await sqs.delete(queue, m.ReceiptHandle!);
    }
    return msgs.length;
  };
  while (bodies.length < expected && Date.now() < deadline) await readOnce();
  while ((await readOnce()) > 0) {
    /* esvazia o resto */
  }
  return bodies;
}

/** Os testes de fila exigem SQS real. Em CI/compose ele existe; aqui falhamos alto se não existir. */
export async function sqsReachable(): Promise<boolean> {
  const sqs = new SqsGateway(loadConfig().aws);
  try {
    await sqs.client.send(new (await import('@aws-sdk/client-sqs')).ListQueuesCommand({}));
    return true;
  } catch {
    return false;
  } finally {
    sqs.close();
  }
}

export const SKIP_SQS = process.env.SKIP_SQS_TESTS === 'true';
