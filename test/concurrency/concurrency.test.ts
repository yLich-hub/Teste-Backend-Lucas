import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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

/**
 * Paralelismo REAL: várias transações abertas ao mesmo tempo no PostgreSQL
 * (pool de 25 conexões) e, no teste multi-processo, 3 processos Bun separados.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createContext({ retryPolicy: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0 } });
});
afterAll(() => ctx.close());

const debitsOf = (walletId: string) =>
  countRows(ctx.db, "select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

describe('Concorrência', () => {
  test('1. a mesma aposta enviada 50x em paralelo => um único débito', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(ctx, bet)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.balance.amount === '90.00')).toBe(true);
    expect(await debitsOf(w.id)).toBe(1);
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('90.00');
    await expectConsistent(ctx, w.id);
  });

  test('2. cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const w = await newWallet(ctx, '100.00');
    const [a, b] = await Promise.all([
      submit(ctx, wagerBody(w, 'BET', '80.00')),
      submit(ctx, wagerBody(w, 'BET', '80.00')),
    ]);
    const statuses = [a!.status, b!.status].sort();
    expect(statuses as string[]).toEqual(['PROCESSED', 'REJECTED']);
    expect(([a, b].find((r) => r!.status === 'REJECTED')!.failureCode) as string).toBe('INSUFFICIENT_FUNDS');
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('20.00');
    expect(await debitsOf(w.id)).toBe(1);

    // retries das duas não duplicam nada
    // (re-submeter exatamente os mesmos payloads é replay)
    await expectConsistent(ctx, w.id);
  });

  test('2b. hot wallet: 40 apostas diferentes de 5.00 com saldo 100 => exatamente 20 aceitas', async () => {
    const w = await newWallet(ctx, '100.00');
    const results = await Promise.all(Array.from({ length: 40 }, () => submit(ctx, wagerBody(w, 'BET', '5.00'))));
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(20);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(20);
    const wallet = await ctx.queries.getWallet(w.id);
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(21);
    await expectConsistent(ctx, w.id);
  });

  test('3. wallets distintas processadas em paralelo', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet(ctx, '50.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(ctx, wagerBody(w, 'BET', '10.00')))),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('0.00');
      await expectConsistent(ctx, w.id);
    }
    expect(elapsed).toBeLessThan(20_000);
  });

  test('4. três PROCESSOS independentes na mesma wallet (com duplicatas entre eles)', async () => {
    const w = await newWallet(ctx, '100.00');
    // 30 apostas distintas de 5.00 => só 20 cabem no saldo. Cada processo manda TODAS
    // (ou seja, cada aposta chega 3x, uma por processo).
    const bets = Array.from({ length: 30 }, () => wagerBody(w, 'BET', '5.00'));
    const script = join(import.meta.dir, '..', 'support', 'bet-worker.ts');
    const procs = [1, 2, 3].map(() =>
      Bun.spawn([process.execPath, script, JSON.stringify(bets)], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'inherit',
      }),
    );
    const outputs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0]);

    const all = outputs.flatMap((o) => JSON.parse(o.trim().split('\n').at(-1)!) as { transactionId: string; status: string; idempotentReplay: boolean }[]);
    expect(all).toHaveLength(90);
    expect(all.filter((r) => !r.idempotentReplay)).toHaveLength(30); // cada aposta decidida uma única vez
    expect(new Set(all.map((r) => r.transactionId)).size).toBe(30);

    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('0.00');
    expect(await debitsOf(w.id)).toBe(20);
    await expectConsistent(ctx, w.id);
  });

  test('5. worker morto depois do COMMIT e antes do ACK: redelivery não duplica', async () => {
    const w = await newWallet(ctx, '100.00');
    const body = wagerBody(w, 'BET', '30.00');
    const messageId = `msg-${randomUUID()}`;
    const inbox = { consumerName: 'test-consumer', messageId, payloadHash: 'p'.repeat(64) };

    // 1ª entrega: commit acontece, mas o processo "morre" antes de apagar a mensagem do SQS.
    const first = await ctx.processWager.execute(command(body), { correlationId: messageId, source: 'sqs', inbox });
    expect(first.duplicateMessage).toBe(false);

    // SQS reentrega a mesma mensagem (3x, inclusive em paralelo) para outras instâncias.
    const redeliveries = await Promise.all(
      [1, 2, 3].map(() => ctx.processWager.execute(command(body), { correlationId: messageId, source: 'sqs', inbox })),
    );
    expect(redeliveries.every((r) => r.duplicateMessage)).toBe(true);
    expect(await debitsOf(w.id)).toBe(1);
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('70.00');
    await expectConsistent(ctx, w.id);
  });

  test('7. ROLLBACK e REFUND entregues antes da referência, em paralelo com ela', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '40.00');
    const refund = wagerBody(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const win = wagerBody(w, 'WIN', '15.00', { roundId: 'round-2' });
    const rollbackWin = wagerBody(w, 'ROLLBACK', '15.00', {
      roundId: 'round-2',
      referenceExternalTransactionId: win.externalTransactionId,
    });

    // reversões chegam primeiro...
    const early = await Promise.all([submit(ctx, refund), submit(ctx, rollbackWin)]);
    expect(early.map((r) => r.status as string)).toEqual(['PENDING_REFERENCE', 'PENDING_REFERENCE']);
    // ...referências chegam depois, enquanto dois workers (duas "instâncias") rodam ao mesmo tempo
    await Promise.all([submit(ctx, bet), submit(ctx, win)]);
    const workerA = new PendingReferenceWorker(ctx.db, ctx.processWager, silentLogger);
    const workerB = new PendingReferenceWorker(ctx.db, ctx.processWager, silentLogger);
    await Promise.all([workerA.runOnce(), workerB.runOnce()]);

    for (const r of early) expect((await ctx.queries.getTransaction(r.transactionId)).status as string).toBe('PROCESSED');
    expect((await ctx.queries.getWallet(w.id)).balance.toString()).toBe('100.00');
    // 1 abertura + BET + WIN + REFUND + ROLLBACK = 5 lançamentos, nenhum duplicado
    expect(await countRows(ctx.db, 'select 1 from wallet_ledger_entries where wallet_id = ?', [w.id])).toBe(5);
    await expectConsistent(ctx, w.id);
  });

  test('8. reinício do serviço: nova conexão retoma pendências e o estado final é consistente', async () => {
    const w = await newWallet(ctx, '100.00');
    const bet = wagerBody(w, 'BET', '25.00');
    const refund = wagerBody(w, 'REFUND', '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submit(ctx, refund);
    await submit(ctx, bet);

    // "Derruba" uma instância e sobe outra (pool novo, nada em memória compartilhado).
    const before = await createContext({ retryPolicy: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0 } });
    await before.close();
    const restarted = await createContext({ retryPolicy: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0 } });
    try {
      await new PendingReferenceWorker(restarted.db, restarted.processWager, silentLogger).runOnce();
      expect((await restarted.queries.getTransaction(pending.transactionId)).status as string).toBe('PROCESSED');
      // replay depois do restart continua idempotente
      const replay = await restarted.processWager.execute(command(bet), { correlationId: 't', source: 'http' });
      expect(!replay.duplicateMessage && replay.idempotentReplay).toBe(true);
      expect((await restarted.queries.getWallet(w.id)).balance.toString()).toBe('100.00');
      await expectConsistent(restarted, w.id);
    } finally {
      await restarted.close();
    }
  });
});
