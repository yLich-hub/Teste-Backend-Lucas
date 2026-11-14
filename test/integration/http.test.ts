import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config';
import { createApp } from '../../src/main';
import { silentLogger } from '../support/context';

/** A API HTTP de ponta a ponta, com a aplicação Nest real e PostgreSQL real. */
let app: INestApplication;
let base: string;

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    PORT: '0',
    // workers ficam fora deste teste (eles têm testes próprios)
    WORKER_CONSUMER: 'false',
    WORKER_OUTBOX: 'false',
    WORKER_PENDING_REFERENCE: 'false',
  });
  app = await createApp(config, silentLogger);
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', 'localhost');
});
afterAll(() => app.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function createWallet(amount = '1000.00') {
  const res = await post('/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return (await res.json() as any) as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

function bet(wallet: { id: string; playerId: string }, amount = '25.00', extra: object = {}) {
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

describe('HTTP API', () => {
  test('POST /wallets -> 201 com version 1; duplicada -> 409', async () => {
    const w = await createWallet();
    expect(w.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(w.version).toBe(1);
    const dup = await post('/wallets', { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect((await dup.json() as any).code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('POST /wagering/transactions: 200 processado, replay idêntico, 409 conflito', async () => {
    const w = await createWallet();
    const { key, body } = bet(w);
    const first = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    const firstJson = await first.json() as any;
    expect(firstJson).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    const replay = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
    expect(await replay.json() as any).toEqual({ ...firstJson, idempotentReplay: true });

    const conflict = await post(
      '/wagering/transactions',
      { ...body, money: { amount: '30.00', currency: 'BRL' } },
      { 'Idempotency-Key': key },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('códigos distintos: 400 inválido, 422 regra de negócio, 202 pendente, 404', async () => {
    const w = await createWallet('10.00');

    const noKey = await post('/wagering/transactions', bet(w).body);
    expect(noKey.status).toBe(400);
    const badAmount = bet(w, '1.001');
    expect((await post('/wagering/transactions', badAmount.body, { 'Idempotency-Key': badAmount.key })).status).toBe(400);
    const opening = bet(w, '1.00', { kind: 'OPENING' });
    expect((await post('/wagering/transactions', opening.body, { 'Idempotency-Key': opening.key })).status).toBe(400);
    expect((await post('/wagering/transactions', '{not json', { 'Idempotency-Key': 'k' })).status).toBe(400);

    const tooBig = bet(w, '50.00');
    const rejected = await post('/wagering/transactions', tooBig.body, { 'Idempotency-Key': tooBig.key });
    expect(rejected.status).toBe(422);
    expect(await rejected.json() as any).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });

    const refund = bet(w, '5.00', { kind: 'REFUND', referenceExternalTransactionId: 'not-arrived-yet' });
    const pending = await post('/wagering/transactions', refund.body, { 'Idempotency-Key': refund.key });
    expect(pending.status).toBe(202);
    expect((await pending.json() as any).status).toBe('PENDING_REFERENCE');

    const unknownWallet = bet({ id: randomUUID(), playerId: 'x' });
    const notFound = await post('/wagering/transactions', unknownWallet.body, { 'Idempotency-Key': unknownWallet.key });
    expect(notFound.status).toBe(404);
    expect((await fetch(`${base}/wallets/${randomUUID()}`)).status).toBe(404);
  });

  test('consultas, ledger paginado e reconciliação', async () => {
    const w = await createWallet('100.00');
    const b = bet(w, '10.00');
    const res = await (await post('/wagering/transactions', b.body, { 'Idempotency-Key': b.key })).json() as any;

    const wallet = await (await fetch(`${base}/wallets/${w.id}`)).json() as any;
    expect(wallet).toMatchObject({ balance: { amount: '90.00' }, version: 2 });

    const tx = await (await fetch(`${base}/wagering/transactions/${res.transactionId}`)).json() as any;
    expect(tx).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '10.00', currency: 'BRL' } });
    const byExternal = await fetch(`${base}/providers/provider-a/wagering/transactions/${b.body.externalTransactionId}`);
    expect((await byExternal.json() as any).transactionId).toBe(res.transactionId);

    const page1 = await (await fetch(`${base}/wallets/${w.id}/ledger?limit=1`)).json() as any;
    expect(page1.items).toHaveLength(1);
    const page2 = await (await fetch(`${base}/wallets/${w.id}/ledger?limit=1&cursor=${page1.nextCursor}`)).json() as any;
    expect(page2.items[0].direction).toBe('DEBIT');
    expect(page2.nextCursor).toBeNull();
    expect((await fetch(`${base}/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);

    const rec = await post(`/wallets/${w.id}/reconciliation`, {});
    expect(rec.status).toBe(200);
    expect(await rec.json() as any).toEqual({
      walletId: w.id,
      storedBalance: { amount: '90.00', currency: 'BRL' },
      calculatedBalance: { amount: '90.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('health e métricas sem autenticação', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect([200, 503]).toContain(ready.status); // 503 se o SQS não estiver no ar
    expect((await ready.json() as any).checks.postgres).toBe(true);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('wager_transactions_total');
    expect(metrics).toContain('wallet_lock_wait_seconds');
  });
});
