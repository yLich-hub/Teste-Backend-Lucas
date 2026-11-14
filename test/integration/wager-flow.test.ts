import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError, WalletNotFoundError } from '../../src/application/errors';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker';
import {
  command,
  countRows,
  createContext,
  expectConsistent,
  newWallet,
  silentLogger,
  submit,
  TestContext,
  wagerBody,
} from '../support/context';

let ctx: TestContext;
beforeAll(async () => {
  // sem espera de backoff, para o worker poder re-tentar na hora
  ctx = await createContext({ retryPolicy: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0 } });
});
afterAll(() => ctx.close());

const eventsOf = (walletId: string) =>
  ctx.db.query<{ event_type: string }>(
    'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type',
    [walletId],
  );

describe('Fluxo de transações (PostgreSQL real)', () => {
  test('criar wallet gera OPENING + CREDIT + eventos na mesma transação', async () => {
    const w = await newWallet(ctx, '1000.00');
    expect(w.version).toBe(1);
    const entries = await ctx.db.query('select direction, amount::text as amount from wallet_ledger_entries where wallet_id = ?', [w.id]);
    expect(entries).toEqual([{ direction: 'CREDIT', amount: '1000.00' }]);
    expect((await eventsOf(w.id)).map((e) => e.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectConsistent(ctx, w.id);
  });

  test('wallet com saldo zero não gera lançamento', async () => {
    const w = await newWallet(ctx, '0.00');
    expect(await countRows(ctx.db, 'select 1 from wallet_ledger_entries where wallet_id = ?', [w.id])).toBe(0);
    await expectConsistent(ctx, w.id);
  });

  test('BET -> WIN -> LOSS -> REFUND -> ROLLBACK', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '25.00');
    expect((await submit(ctx, bet)).balance.amount).toBe('75.00');

    const win = wagerBody(w, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(ctx, win)).balance.amount).toBe('125.00');

    const loss = await submit(ctx, wagerBody(w, 'LOSS', '10.00', { roundId: 'round-2' }));
    expect(loss.status as string).toBe('PROCESSED');
    expect(loss.balance.amount).toBe('125.00');

    const bet2 = wagerBody(w, 'BET', '20.00', { roundId: 'round-3' });
    await submit(ctx, bet2);
    const refund = await submit(
      ctx,
      wagerBody(w, 'REFUND', '20.00', { roundId: 'round-3', referenceExternalTransactionId: bet2.externalTransactionId }),
    );
    expect(refund.balance.amount).toBe('125.00');

    const rollbackWin = await submit(
      ctx,
      wagerBody(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rollbackWin.status as string).toBe('PROCESSED');
    expect(rollbackWin.balance.amount).toBe('75.00');

    const wallet = await ctx.queries.getWallet(w.id);
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(6); // 1 (abertura) + BET, WIN, BET2, REFUND, ROLLBACK (LOSS não conta)
    // LOSS não gera lançamento: 1 abertura + 5 movimentos
    expect(await countRows(ctx.db, 'select 1 from wallet_ledger_entries where wallet_id = ?', [w.id])).toBe(6);
    await expectConsistent(ctx, w.id);
  });

  test('replay devolve o resultado ORIGINAL, inclusive o saldo daquele momento', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '10.00');
    const first = await submit(ctx, bet);
    await submit(ctx, wagerBody(w, 'BET', '30.00')); // saldo muda depois
    const replay = await submit(ctx, bet);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance.amount).toBe('90.00');
    await expectConsistent(ctx, w.id);
  });

  test('mesma key com payload diferente = conflito (e nada muda)', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '10.00');
    await submit(ctx, bet);
    expect(submit(ctx, { ...bet, money: { amount: '11.00', currency: 'BRL' } })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    // mesmo externalTransactionId com outra key também é conflito
    const sameExternalOtherKey = ctx.processWager.execute(command(bet, 'other-key'), {
      correlationId: 't',
      source: 'http',
    });
    expect(sameExternalOtherKey).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('90.00');
  });

  test('rejeições não mexem no saldo nem geram lançamento, mas geram evento', async () => {
    const w = await newWallet(ctx, '10.00');
    const res = await submit(ctx, wagerBody(w, 'BET', '10.01'));
    expect(res.status as string).toBe('REJECTED');
    expect(res.failureCode as string).toBe('INSUFFICIENT_FUNDS');
    expect(res.balance.amount).toBe('10.00');
    const usd = await submit(ctx, { ...wagerBody(w, 'BET', '1.00'), money: { amount: '1.00', currency: 'USD' } });
    expect(usd.failureCode as string).toBe('CURRENCY_MISMATCH');
    expect(await countRows(ctx.db, 'select 1 from wallet_ledger_entries where wallet_id = ?', [w.id])).toBe(1);
    expect((await eventsOf(w.id)).filter((e) => e.event_type === 'WagerTransactionRejected')).toHaveLength(2);
    await expectConsistent(ctx, w.id);
  });

  test('REFUND duas vezes da mesma BET: a segunda é ALREADY_REVERSED', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '40.00');
    await submit(ctx, bet);
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    expect((await submit(ctx, wagerBody(w, 'REFUND', '40.00', ref))).status as string).toBe('PROCESSED');
    const second = await submit(ctx, wagerBody(w, 'REFUND', '40.00', ref));
    expect(second.failureCode as string).toBe('ALREADY_REVERSED');
    const rollback = await submit(ctx, wagerBody(w, 'ROLLBACK', '40.00', ref));
    expect(rollback.failureCode as string).toBe('ALREADY_REVERSED');
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('100.00');
    await expectConsistent(ctx, w.id);
  });

  test('ROLLBACK de WIN sem saldo: REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const w = await newWallet(ctx, '0.00');
    const win = wagerBody(w, 'WIN', '50.00');
    await submit(ctx, win);
    await submit(ctx, wagerBody(w, 'BET', '45.00'));
    const rb = await submit(
      ctx,
      wagerBody(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rb.status as string).toBe('REJECTED');
    expect(rb.failureCode as string).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    await expectConsistent(ctx, w.id);
  });

  test('wallet inexistente: erro (nada é gravado)', async () => {
    const fake = { id: randomUUID(), playerId: 'p' };
    expect(submit(ctx, wagerBody(fake, 'BET', '1.00'))).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('atomicidade: falha antes do COMMIT não deixa NADA (wallet, ledger, inbox, outbox)', async () => {
    const w = await newWallet(ctx, '100.00');
    const before = await ctx.db.query('select count(*)::int as n from outbox_messages');
    // Executa o mesmo use case, mas "mata o processo" logo antes do COMMIT:
    // o hook roda dentro da transação, depois de tudo gravado.
    const original = ctx.db.transaction.bind(ctx.db);
    const crashingDb = Object.create(ctx.db) as typeof ctx.db;
    crashingDb.transaction = (fn) =>
      original(async (tx) => {
        await fn(tx);
        throw new Error('processo morreu antes do commit');
      });
    const service = new (await import('../../src/application/process-wager.service')).ProcessWagerService(
      crashingDb,
      ctx.metrics,
      silentLogger,
    );
    const crash = service.execute(command(wagerBody(w, 'BET', '10.00')), {
      correlationId: 't',
      source: 'sqs',
      inbox: { consumerName: 'test', messageId: `m-${randomUUID()}`, payloadHash: 'x'.repeat(64) },
    });
    expect(crash).rejects.toThrow('processo morreu');
    await crash.catch(() => undefined);
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('100.00');
    expect(await ctx.db.query('select count(*)::int as n from outbox_messages')).toEqual(before);
    expect(await countRows(ctx.db, "select 1 from inbox_messages where consumer_name = 'test'")).toBe(0);
    await expectConsistent(ctx, w.id);
  });
});

describe('Referência fora de ordem (PENDING_REFERENCE)', () => {
  test('REFUND antes da BET: fica pendente e o worker aplica quando a BET chega', async () => {
    const w = await newWallet(ctx, '100.00');
    const betExt = `bet-${randomUUID()}`;
    const refund = await submit(ctx, wagerBody(w, 'REFUND', '30.00', { referenceExternalTransactionId: betExt }));
    expect(refund.status as string).toBe('PENDING_REFERENCE');
    expect((await eventsOf(w.id)).some((e) => e.event_type === 'WagerTransactionPendingReference')).toBe(true);

    await submit(ctx, wagerBody(w, 'BET', '30.00', { externalTransactionId: betExt }));
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('70.00');

    const worker = new PendingReferenceWorker(ctx.db, ctx.processWager, silentLogger);
    await worker.runOnce();

    const tx = await ctx.queries.getTransaction(refund.transactionId);
    expect(tx.status as string).toBe('PROCESSED');
    expect(tx.referenceTransactionId).toBeDefined();
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('100.00');
    // replay do REFUND agora mostra o estado atual
    expect((await submit(ctx, wagerBody(w, 'REFUND', '30.00', { referenceExternalTransactionId: betExt, externalTransactionId: tx.externalTransactionId }))).status as string).toBe('PROCESSED');
    await expectConsistent(ctx, w.id);
  });

  test('referência que nunca chega: REJECTED REFERENCE_NOT_FOUND após o limite, com evento', async () => {
    let now = Date.now();
    const quick = await createContext({
      retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
      clock: () => new Date(now),
    });
    try {
      const w = await newWallet(quick, '100.00');
      const res = await submit(quick, wagerBody(w, 'ROLLBACK', '5.00', { referenceExternalTransactionId: 'ghost' }));
      expect(res.status as string).toBe('PENDING_REFERENCE');
      const worker = new PendingReferenceWorker(quick.db, quick.processWager, silentLogger, () => new Date(now));
      for (let i = 0; i < 3; i++) {
        now += 1000;
        await worker.runOnce();
      }
      const tx = await quick.queries.getTransaction(res.transactionId);
      expect(tx.status as string).toBe('REJECTED');
      expect(tx.failureCode as string).toBe('REFERENCE_NOT_FOUND');
      const events = await quick.db.query('select event_type from outbox_messages where aggregate_id = ?', [w.id]);
      expect(events.some((e) => e.event_type === 'WagerTransactionRejected')).toBe(true);
      await expectConsistent(quick, w.id);
    } finally {
      await quick.close();
    }
  });
});

describe('Consultas', () => {
  test('ledger paginado com cursor opaco e estável', async () => {
    const w = await newWallet(ctx, '100.00');
    for (let i = 0; i < 4; i++) await submit(ctx, wagerBody(w, 'BET', '1.00'));
    const page1 = await ctx.queries.getLedger(w.id, undefined, '2');
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeString();
    const page2 = await ctx.queries.getLedger(w.id, page1.nextCursor!, '2');
    const page3 = await ctx.queries.getLedger(w.id, page2.nextCursor!, '2');
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
    const all = [...page1.items, ...page2.items, ...page3.items];
    expect(new Set(all.map((i) => i.id)).size).toBe(5);
    expect(all.at(-1)!.balanceAfter.amount).toBe('96.00');
  });

  test('busca por (providerId, externalTransactionId)', async () => {
    const w = await newWallet(ctx, '10.00');
    const body = wagerBody(w, 'BET', '1.00');
    const res = await submit(ctx, body);
    const found = await ctx.queries.getTransactionByExternalId('provider-a', body.externalTransactionId);
    expect(found.id).toBe(res.transactionId);
  });
});
