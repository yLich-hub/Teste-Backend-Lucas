import type { Row, SqlRunner } from '../database';
import { FailureCode } from '../../../domain/errors';
import { Money } from '../../../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction';

// balance_after é o saldo da WALLET, então vem na moeda da wallet (join).
const SELECT = `select t.id, t.provider_id, t.external_transaction_id, t.idempotency_key, t.payload_hash,
  t.wallet_id, t.player_id, t.round_id, t.game_id, t.kind, t.amount::text as amount, t.currency,
  t.reference_external_transaction_id, t.reference_transaction_id, t.status, t.failure_code,
  t.balance_after::text as balance_after, w.currency as wallet_currency, t.reference_attempts,
  t.next_reference_check_at, t.created_at, t.processed_at
  from wager_transactions t join wallets w on w.id = t.wallet_id`;

export class WagerTransactionRepository {
  constructor(private readonly db: SqlRunner) {}

  async insert(t: WagerTransaction): Promise<void> {
    await this.db.query(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency,
         reference_external_transaction_id, reference_transaction_id, status, failure_code,
         balance_after, reference_attempts, next_reference_check_at, created_at, processed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.providerId,
        t.externalTransactionId,
        t.idempotencyKey,
        t.payloadHash,
        t.walletId,
        t.playerId,
        t.roundId,
        t.gameId,
        t.kind,
        t.money.toString(),
        t.money.currency,
        t.referenceExternalTransactionId ?? null,
        t.referenceTransactionId ?? null,
        t.status,
        t.failureCode ?? null,
        t.balanceAfter?.toString() ?? null,
        t.referenceAttempts,
        t.nextReferenceCheckAt ?? null,
        t.createdAt,
        t.processedAt ?? null,
      ],
    );
  }

  /** Só os campos mutáveis (status e afins). Os dados de negócio nunca mudam. */
  async update(t: WagerTransaction): Promise<void> {
    await this.db.query(
      `update wager_transactions
          set status = ?, reference_transaction_id = ?, failure_code = ?, balance_after = ?,
              reference_attempts = ?, next_reference_check_at = ?, processed_at = ?
        where id = ?`,
      [
        t.status,
        t.referenceTransactionId ?? null,
        t.failureCode ?? null,
        t.balanceAfter?.toString() ?? null,
        t.referenceAttempts,
        t.nextReferenceCheckAt ?? null,
        t.processedAt ?? null,
        t.id,
      ],
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const [row] = await this.db.query(`${SELECT} where t.id = ?`, [id]);
    return row ? toTransaction(row) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const [row] = await this.db.query(
      `${SELECT} where t.provider_id = ? and t.external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return row ? toTransaction(row) : undefined;
  }

  /** Procura uma transação que já "ocupa" a idempotency key OU o id externo. */
  async findExisting(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const [row] = await this.db.query(
      `${SELECT}
        where t.provider_id = ? and (t.idempotency_key = ? or t.external_transaction_id = ?)
        order by (t.idempotency_key = ?) desc
        limit 1`,
      [providerId, idempotencyKey, externalTransactionId, idempotencyKey],
    );
    return row ? toTransaction(row) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.db.query(
      `select 1 from wager_transactions
        where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
        limit 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  /** Ids de transações esperando referência cuja próxima checagem já venceu. */
  async findDuePendingReference(now: Date, limit: number): Promise<string[]> {
    const rows = await this.db.query(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
        order by next_reference_check_at
        limit ?`,
      [now, limit],
    );
    return rows.map((r) => r.id as string);
  }
}

function toTransaction(row: Row): WagerTransaction {
  const currency = row.currency as string;
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status as WagerTransactionStatus,
    failureCode: (row.failure_code as FailureCode | null) ?? undefined,
    balanceAfter:
      row.balance_after != null ? Money.from({ amount: row.balance_after, currency: row.wallet_currency }) : undefined,
    referenceAttempts: Number(row.reference_attempts),
    nextReferenceCheckAt: row.next_reference_check_at ? new Date(row.next_reference_check_at) : undefined,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  });
}
