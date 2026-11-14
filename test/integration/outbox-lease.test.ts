import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, newWallet, TestContext } from '../support/context';

/**
 * Lease da outbox no PostgreSQL real (sem SQS): é o banco que garante que
 * publishers concorrentes não pegam o mesmo evento e que um publisher morto
 * não "segura" eventos para sempre.
 */
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createContext();
  // começa de uma outbox "limpa" para este arquivo: marca o que sobrou de outros testes
  await ctx.db.query('update outbox_messages set published_at = now(), locked_by = null, locked_until = null where published_at is null');
});
afterAll(() => ctx.close());

describe('Outbox com lease', () => {
  test('dois publishers concorrentes recebem lotes disjuntos', async () => {
    for (let i = 0; i < 10; i++) await newWallet(ctx, '10.00'); // 2 eventos cada = 20
    const now = new Date(Date.now() + 1000);
    const [a, b] = await Promise.all([
      ctx.db.outbox.claimDueBatch('pub-A', now, 15, 30_000),
      ctx.db.outbox.claimDueBatch('pub-B', now, 15, 30_000),
    ]);
    const idsA = new Set(a!.map((m) => m.id));
    expect(b!.some((m) => idsA.has(m.id))).toBe(false); // nenhum evento nos dois
    expect(a!.length + b!.length).toBe(20);

    // um terceiro publisher não encontra nada: tudo está alugado
    expect(await ctx.db.outbox.claimDueBatch('pub-C', now, 50, 30_000)).toHaveLength(0);

    // A e B publicam e devolvem o aluguel
    for (const [owner, batch] of [['pub-A', a!], ['pub-B', b!]] as const) {
      for (const m of batch) {
        m.markPublished(new Date());
        expect(await ctx.db.outbox.release(m, owner)).toBe(true);
      }
    }
    expect(await ctx.db.outbox.claimDueBatch('pub-C', now, 50, 30_000)).toHaveLength(0);
  });

  test('publisher morre: quando o lease vence, outro assume; o atrasado não sobrescreve', async () => {
    await newWallet(ctx, '10.00');
    const now = new Date(Date.now() + 1000);
    const dead = await ctx.db.outbox.claimDueBatch('pub-morto', now, 50, 200);
    expect(dead.length).toBe(2);

    expect(await ctx.db.outbox.claimDueBatch('pub-vivo', now, 50, 30_000)).toHaveLength(0); // ainda alugado
    await Bun.sleep(300);
    const taken = await ctx.db.outbox.claimDueBatch('pub-vivo', now, 50, 30_000);
    expect(taken.map((m) => m.id).sort()).toEqual(dead.map((m) => m.id).sort());

    // o publisher "morto" volta à vida e tenta marcar: é recusado (lease não é mais dele)
    dead[0]!.markPublished(new Date());
    expect(await ctx.db.outbox.release(dead[0]!, 'pub-morto')).toBe(false);

    for (const m of taken) {
      m.markPublished(new Date());
      expect(await ctx.db.outbox.release(m, 'pub-vivo')).toBe(true);
    }
    const [row] = await ctx.db.query('select count(*)::int as n from outbox_messages where published_at is null');
    expect(row!.n).toBe(0);
  });

  test('falha de publicação reagenda com backoff e libera o lease', async () => {
    await newWallet(ctx, '10.00');
    const now = new Date(Date.now() + 1000);
    const [m] = await ctx.db.outbox.claimDueBatch('pub-X', now, 1, 30_000);
    m!.scheduleRetry(now);
    expect(await ctx.db.outbox.release(m!, 'pub-X')).toBe(true);
    // ainda não venceu o backoff (1s depois de `now`)
    const again = await ctx.db.outbox.claimDueBatch('pub-Y', now, 50, 30_000);
    expect(again.some((x) => x.id === m!.id)).toBe(false);
    const later = await ctx.db.outbox.claimDueBatch('pub-Y', new Date(now.getTime() + 1500), 50, 30_000);
    expect(later.find((x) => x.id === m!.id)?.attempts).toBe(1);
  });
});
