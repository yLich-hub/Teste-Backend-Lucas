import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../domain/errors';
import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';

const id = z.string().trim().min(1).max(200);

const moneySchema = z.object({ amount: z.string(), currency: z.string() }).strict();

/** Contrato de entrada — o MESMO para HTTP e SQS. OPENING não é aceito (é interno). */
const wagerSchema = z
  .object({
    providerId: id,
    externalTransactionId: id,
    playerId: id,
    walletId: z.string().uuid(),
    roundId: id,
    gameId: id,
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: moneySchema,
    referenceExternalTransactionId: id.optional(),
  })
  .strict();

export interface WagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  /** sha256 do JSON canônico dos campos de negócio */
  payloadHash: string;
}

/** Valida o corpo + a idempotency key e devolve um comando pronto para o use case. */
export function parseWagerCommand(body: unknown, idempotencyKey: unknown): WagerCommand {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '' || idempotencyKey.length > 300) {
    throw new ValidationError('Idempotency-Key is required');
  }
  const parsed = wagerSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ValidationError(`${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  const data = parsed.data;
  const money = Money.from(data.money); // valida escala, sinal, moeda...

  const command: Omit<WagerCommand, 'payloadHash'> = {
    idempotencyKey,
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money,
    referenceExternalTransactionId: data.referenceExternalTransactionId,
  };
  return { ...command, payloadHash: wagerPayloadHash(command) };
}

/**
 * payloadHash = sha256( JSON canônico dos campos de negócio ).
 * - entram: providerId, externalTransactionId, playerId, walletId, roundId,
 *   gameId, kind, money (normalizado: "25" vira "25.00"), referenceExternalTransactionId;
 * - NÃO entram: a Idempotency-Key, headers, messageId, occurredAt (transporte).
 * - "canônico" = chaves ordenadas alfabeticamente em todos os níveis,
 *   sem espaços, campos ausentes omitidos.
 */
export function wagerPayloadHash(c: Omit<WagerCommand, 'payloadHash'>): string {
  return sha256(
    canonicalJson({
      providerId: c.providerId,
      externalTransactionId: c.externalTransactionId,
      playerId: c.playerId,
      walletId: c.walletId,
      roundId: c.roundId,
      gameId: c.gameId,
      kind: c.kind,
      money: c.money.toJSON(),
      referenceExternalTransactionId: c.referenceExternalTransactionId,
    }),
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
