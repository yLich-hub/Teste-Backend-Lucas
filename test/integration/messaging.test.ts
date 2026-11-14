import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransientError } from '../../src/application/errors';
import { ProcessWagerService } from '../../src/application/process-wager.service';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { WagerQueueConsumer } from '../../src/infrastructure/messaging/wager-queue-consumer';
import { OutboxPublisher } from '../../src/infrastructure/workers/outbox-publisher';
import {
  countRows,
  createContext,
  createTestQueues,
  drain,
  expectConsistent,
  newWallet,
  silentLogger,
  SKIP_SQS,
  sqsReachable,
  submit,
  TestContext,
  wagerBody,
} from '../support/context';

/**
 * Inbox, outbox, retry e DLQ com SQS REAL (LocalStack/MiniStack) e PostgreSQL REAL.
 * Requer `docker compose up -d` (ver README). Cada execução cria filas próprias.
 */
let ctx: TestContext;
let sqs: SqsGateway;
let queues: { wager: string; dlq: string; events: string };

describe.skipIf(SKIP_SQS)('Mensageria (SQS real)', () => {
  beforeAll(async () => {
    if (!(await sqsReachable())) {
      throw new Error('SQS não está acessível. Suba a infra com `docker compose up -d` (ou SKIP_SQS_TESTS=true).');
    }
    ctx = await createContext();
    ({ sqs, queues } = await createTestQueues('msg', 3));
  });
  afterAll(async () => {
    sqs?.close();
    await ctx?.close();
  });

  const consumerWith = (processWager: ProcessWagerService) =>
    new WagerQueueConsumer(sqs, processWager, ctx.metrics, silentLogger, {
      queue: queues.wager,
      dlq: queues.dlq,
      consumerName: 'wager-test-consumer',
      maxReceives: 3,
      waitSeconds: 1,
      visibilityTimeout: 30,
    });

  const envelope = (data: Record<string, unknown>, messageId = `msg-${randomUUID()}`) =>
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
    });

  const receiveOne = async (queue: string) => {
    for (let i = 0; i < 15; i++) {
      const [m] = await sqs.receive(queue, { max: 1, waitSeconds: 1 });
      if (m) return m;
    }
    throw new Error(`nenhuma mensagem em ${queue}`);
  };

  test('mensagem válida: processa, faz ack só depois do commit', async () => {
    const w = await newWallet(ctx, '100.00');
    await sqs.send(queues.wager, envelope(wagerBody(w, 'BET', '15.00')), { groupId: w.id, deduplicationId: randomUUID() });
    const decision = await consumerWith(ctx.processWager).handle(await receiveOne(queues.wager));
    expect(decision.action).toBe('ack');
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('85.00');
    expect(await sqs.receive(queues.wager, { waitSeconds: 1 })).toHaveLength(0);
    await expectConsistent(ctx, w.id);
  });

  test('worker morre depois do commit e antes do ack: redelivery é deduplicada pelo inbox', async () => {
    const w = await newWallet(ctx, '100.00');
    await sqs.send(queues.wager, envelope(wagerBody(w, 'BET', '40.00')), { groupId: w.id, deduplicationId: randomUUID() });
    const consumer = consumerWith(ctx.processWager);

    const first = await receiveOne(queues.wager);
    expect((await consumer.process(first)).action).toBe('ack'); // COMMIT feito...
    // ...e o processo "morre" aqui: nenhum delete. A visibilidade expira:
    await sqs.changeVisibility(queues.wager, first.ReceiptHandle!, 0);

    const redelivered = await receiveOne(queues.wager);
    expect(Number(redelivered.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(2);
    expect((await consumer.handle(redelivered)).action).toBe('ack');

    expect(await countRows(ctx.db, "select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.id])).toBe(1);
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('60.00');
    await expectConsistent(ctx, w.id);
  });

  test('erro permanente (payload inválido) vai direto para a DLQ', async () => {
    await sqs.send(queues.wager, JSON.stringify({ messageId: 'x', type: 'WagerTransactionRequested', data: {} }), {
      groupId: 'g',
      deduplicationId: randomUUID(),
    });
    const decision = await consumerWith(ctx.processWager).handle(await receiveOne(queues.wager));
    expect(decision).toEqual({ action: 'dlq', reason: 'INVALID_MESSAGE' });
    const [dead] = await drain(sqs, queues.dlq, 1);
    expect(dead!.attributes.failureReason).toBe('INVALID_MESSAGE');
  });

  test('erro transitório: retry com backoff e, esgotado o limite, DLQ', async () => {
    const failing = {
      execute: async () => {
        throw new TransientError('database down');
      },
    } as unknown as ProcessWagerService;
    const consumer = consumerWith(failing);
    const w = await newWallet(ctx, '10.00');
    await sqs.send(queues.wager, envelope(wagerBody(w, 'BET', '1.00')), { groupId: w.id, deduplicationId: randomUUID() });

    const actions: string[] = [];
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const [m] = await sqs.receive(queues.wager, { max: 1, waitSeconds: 2 });
      if (!m) continue;
      await consumer.handle(m);
      actions.push(m.Attributes!.ApproximateReceiveCount!);
      if (Number(m.Attributes!.ApproximateReceiveCount) >= 3) break;
    }
    expect(actions).toEqual(['1', '2', '3']);
    const [dead] = await drain(sqs, queues.dlq, 1);
    expect(dead!.attributes.failureReason).toBe('MAX_RECEIVES_EXCEEDED');
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('10.00');
  }, 60_000);

  test('dois publishers concorrentes na mesma outbox: cada evento sai uma vez', async () => {
    const walletIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const w = await newWallet(ctx, '50.00');
      walletIds.push(w.id);
      await submit(ctx, wagerBody(w, 'BET', '5.00'));
    }
    const ours = await ctx.db.query<{ id: string }>(
      `select id from outbox_messages where aggregate_id in (${walletIds.map(() => '?').join(',')})`,
      walletIds,
    );
    expect(ours.length).toBe(40); // por wallet: Processed+BalanceChanged (abertura) e (BET)

    const publisherA = new OutboxPublisher(ctx.db, sqs, ctx.metrics, silentLogger, { queue: queues.events, batchSize: 7 });
    const publisherB = new OutboxPublisher(ctx.db, sqs, ctx.metrics, silentLogger, { queue: queues.events, batchSize: 7 });
    const runUntilEmpty = async (p: OutboxPublisher) => {
      while ((await p.publishBatch()) > 0) {
        /* continua */
      }
    };
    await Promise.all([runUntilEmpty(publisherA), runUntilEmpty(publisherB)]);

    const ids = new Set(ours.map((o) => o.id));
    const received = await drain(sqs, queues.events, 40, 20_000, (m) => ids.has(m.attributes.eventId!));
    const counts = new Map<string, number>();
    for (const m of received) counts.set(m.attributes.eventId!, (counts.get(m.attributes.eventId!) ?? 0) + 1);
    expect(counts.size).toBe(40);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(
      await countRows(ctx.db, `select 1 from outbox_messages where published_at is null and id in (${[...ids].map(() => '?').join(',')})`, [...ids]),
    ).toBe(0);
  }, 60_000);

  test('publisher morre depois de publicar e antes de marcar: o lease vence e outro republica (duplicata segura)', async () => {
    const w = await newWallet(ctx, '20.00');
    const [event] = await ctx.db.query<{ id: string }>(
      "select id from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged'",
      [w.id],
    );
    // Instância 1: aluga o lote por 300ms, publica e "morre" sem marcar published_at.
    const claimed = await ctx.db.outbox.claimDueBatch('instancia-1', new Date(), 10_000, 300);
    const msg = claimed.find((m) => m.id === event!.id)!;
    await sqs.send(queues.events, JSON.stringify(msg.payload), { attributes: { eventId: msg.id } });
    await Bun.sleep(400); // aluguel vence

    // Instância 2 assume o trabalho.
    const publisher = new OutboxPublisher(ctx.db, sqs, ctx.metrics, silentLogger, { queue: queues.events });
    while ((await publisher.publishBatch()) > 0) {
      /* continua */
    }
    const copies = await drain(sqs, queues.events, 2, 15_000, (m) => m.attributes.eventId === event!.id);
    expect(copies).toHaveLength(2); // at-least-once...
    expect(JSON.parse(copies[0]!.body).eventId).toBe(JSON.parse(copies[1]!.body).eventId); // ...com o mesmo eventId
    const [row] = await ctx.db.query('select published_at from outbox_messages where id = ?', [event!.id]);
    expect(row!.published_at).not.toBeNull();
  }, 60_000);
});
