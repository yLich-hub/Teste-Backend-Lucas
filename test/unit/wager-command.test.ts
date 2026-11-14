import { describe, expect, test } from 'bun:test';
import { canonicalJson, parseWagerCommand } from '../../src/application/wager-command';
import { ValidationError } from '../../src/domain/errors';
import { OutboxMessage } from '../../src/domain/outbox-message';

const body = () => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});
const KEY = 'provider-a:transaction-123';

describe('Idempotência: payloadHash', () => {
  test('JSON canônico ordena chaves em todos os níveis', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('mesmo payload com chaves em outra ordem => mesmo hash', () => {
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    expect(parseWagerCommand(reordered, KEY).payloadHash).toBe(parseWagerCommand(body(), KEY).payloadHash);
  });

  test('a idempotency key (header) não entra no hash', () => {
    expect(parseWagerCommand(body(), 'outra-key').payloadHash).toBe(parseWagerCommand(body(), KEY).payloadHash);
  });

  test('valor normalizado: "25" e "25.00" são o mesmo payload', () => {
    const b = { ...body(), money: { amount: '25', currency: 'BRL' } };
    expect(parseWagerCommand(b, KEY).payloadHash).toBe(parseWagerCommand(body(), KEY).payloadHash);
  });

  test('payload divergente => hash diferente (vira conflito, não replay)', () => {
    const b = { ...body(), money: { amount: '26.00', currency: 'BRL' } };
    expect(parseWagerCommand(b, KEY).payloadHash).not.toBe(parseWagerCommand(body(), KEY).payloadHash);
  });
});

describe('Validação do contrato de entrada', () => {
  test('Idempotency-Key é obrigatória', () => {
    expect(() => parseWagerCommand(body(), undefined)).toThrow(ValidationError);
    expect(() => parseWagerCommand(body(), '  ')).toThrow(ValidationError);
  });

  test('OPENING é interno e não pode ser submetido', () => {
    expect(() => parseWagerCommand({ ...body(), kind: 'OPENING' }, KEY)).toThrow(ValidationError);
  });

  test('money como number é rejeitado', () => {
    expect(() => parseWagerCommand({ ...body(), money: { amount: 25, currency: 'BRL' } }, KEY)).toThrow(
      ValidationError,
    );
  });

  test('campos extras são rejeitados', () => {
    expect(() => parseWagerCommand({ ...body(), hacker: true }, KEY)).toThrow(ValidationError);
  });
});

describe('OutboxMessage', () => {
  test('backoff de retry e publicação', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const msg = OutboxMessage.rehydrate({
      id: 'e1',
      aggregateId: 'w1',
      eventType: 'X',
      payload: {},
      occurredAt: now,
      attempts: 0,
      nextAttemptAt: now,
    });
    expect(msg.isDue(now)).toBe(true);
    msg.scheduleRetry(now);
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(now)).toBe(false);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(1000);
    msg.scheduleRetry(now);
    expect(msg.nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
    msg.markPublished(now);
    expect(msg.isPending()).toBe(false);
  });
});
