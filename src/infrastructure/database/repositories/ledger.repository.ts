import type { Row, SqlRunner } from '../database';
import { Money } from '../../../domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** seq do último item da página (base do próximo cursor) */
  lastSeq?: string;
  hasMore: boolean;
}

export class LedgerRepository {
  constructor(private readonly db: SqlRunner) {}

  /** Só INSERT. Não existe update/delete aqui — e o banco também os bloqueia. */
  async insert(e: WalletLedgerEntry): Promise<void> {
    await this.db.query(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        e.walletId,
        e.transactionId,
        e.direction,
        e.money.toString(),
        e.money.currency,
        e.balanceBefore.toString(),
        e.balanceAfter.toString(),
        e.createdAt,
      ],
    );
  }

  /** Paginação por keyset (seq > cursor): estável mesmo com inserts concorrentes. */
  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    const rows = await this.db.query(
      `select seq::text as seq, id, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq
        limit ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      entries: pageRows.map(toEntry),
      lastSeq: pageRows.at(-1)?.seq,
      hasMore,
    };
  }

  /** Saldo reconstruído a partir do ledger: soma(créditos) - soma(débitos). */
  async calculatedBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    const [row] = await this.db.query(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as net,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const net = String(row!.net);
    const balance = net.startsWith('-')
      ? Money.from({ amount: net.slice(1), currency }).negate()
      : Money.from({ amount: net, currency });
    return { balance, entries: Number(row!.entries) };
  }
}

function toEntry(row: Row): WalletLedgerEntry {
  const currency = row.currency as string;
  const money = (amount: string) => Money.from({ amount, currency });
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balance_before),
    balanceAfter: money(row.balance_after),
    createdAt: new Date(row.created_at),
  });
}
