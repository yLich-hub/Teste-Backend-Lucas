import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WalletAlreadyExistsError } from '../../src/application/errors';
import { createContext, newWallet, submit, TestContext, wagerBody } from '../support/context';

/**
 * As garantias valem no BANCO, mesmo se alguém passar por cima do código de
 * aplicação. Aqui tentamos violar cada uma com SQL direto.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createContext();
});
afterAll(() => ctx.close());

const failsWith = async (sql: string, params: unknown[], pattern: RegExp) => {
  let error: any;
  try {
    await ctx.db.transaction((tx) => tx.query(sql, params));
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(String(error.message)).toMatch(pattern);
};

describe('Migrations e constraints', () => {
  test('migrations são reversíveis (down + up)', async () => {
    const other = await createContext();
    try {
      // usa um schema separado para não derrubar as tabelas dos outros testes
      const schema = `mig_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      await other.db.query(`create schema ${schema}`);
      const tables = (s: string) =>
        other.db.query(`select table_name from information_schema.tables where table_schema = ?`, [s]);
      // Executa o SQL da migration diretamente no schema isolado.
      const { Migration20261113000000_initial: M } = await import(
        '../../src/infrastructure/database/migrations/Migration20261113000000_initial'
      );
      const run = async (dir: 'up' | 'down') => {
        const m = new (M as any)(other.db.orm.em.getDriver(), other.db.orm.config);
        await m[dir]();
        await other.db.transaction(async (tx) => {
          await tx.query(`set local search_path to ${schema}`);
          for (const sql of m.getQueries()) await tx.query(sql.sql ?? sql);
        });
      };
      await run('up');
      expect((await tables(schema)).length).toBe(5);
      await run('down');
      expect((await tables(schema)).length).toBe(0);
      await other.db.query(`drop schema ${schema} cascade`);
    } finally {
      await other.close();
    }
  });

  test('1 wallet por playerId + currency', async () => {
    const w = await newWallet(ctx);
    expect(
      ctx.createWallet.execute({ playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } }, 't'),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    // outra moeda pode
    await ctx.createWallet.execute({ playerId: w.playerId, initialBalance: { amount: '0', currency: 'USD' } }, 't');
  });

  test('saldo negativo é barrado pelo CHECK', async () => {
    const w = await newWallet(ctx, '10.00');
    await failsWith('update wallets set balance = -1 where id = ?', [w.id], /check constraint|violates/i);
  });

  test('saldo da wallet diferente do ledger é barrado no COMMIT', async () => {
    const w = await newWallet(ctx, '10.00');
    await failsWith('update wallets set balance = 99 where id = ?', [w.id], /does not match ledger/);
  });

  test('ledger é append-only: UPDATE e DELETE bloqueados', async () => {
    const w = await newWallet(ctx, '10.00');
    await failsWith('update wallet_ledger_entries set amount = 1 where wallet_id = ?', [w.id], /append-only/);
    await failsWith('delete from wallet_ledger_entries where wallet_id = ?', [w.id], /append-only/);
  });

  test('lançamento com aritmética errada é barrado', async () => {
    const w = await newWallet(ctx, '10.00');
    const [t] = await ctx.db.query('select transaction_id from wallet_ledger_entries where wallet_id = ?', [w.id]);
    await failsWith(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'CREDIT', 5, 'BRL', 10, 20, now())`,
      [randomUUID(), w.id, t!.transaction_id],
      /ledger_entry_is_balanced|ledger_one_entry_per_transaction/,
    );
  });

  test('transação terminal não muda nem é apagada', async () => {
    const w = await newWallet(ctx, '10.00');
    const res = await submit(ctx, wagerBody(w, 'BET', '1.00'));
    await failsWith("update wager_transactions set status = 'REJECTED' where id = ?", [res.transactionId], /terminal/);
    await failsWith('delete from wager_transactions where id = ?', [res.transactionId], /cannot be deleted/);
  });

  test('mesma idempotency key não pode existir duas vezes para o provider', async () => {
    const w = await newWallet(ctx, '10.00');
    const body = wagerBody(w, 'BET', '1.00');
    await submit(ctx, body);
    const [row] = await ctx.db.query('select * from wager_transactions where external_transaction_id = ?', [
      body.externalTransactionId,
    ]);
    await failsWith(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now())`,
      [randomUUID(), row!.provider_id, 'another-ext', row!.idempotency_key, row!.payload_hash, w.id, w.playerId],
      /wager_tx_idempotency_uq/,
    );
  });
});
