import { ValidationError } from '../domain/errors';
import { MoneyProps } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { Database } from '../infrastructure/database/database';
import { JsonLogger } from '../infrastructure/observability/logger';
import { Metrics } from '../infrastructure/observability/metrics';
import { TransactionNotFoundError, WalletNotFoundError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Consultas (somente leitura) e reconciliação. */
export class WalletQueriesService {
  constructor(
    private readonly db: Database,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = UUID.test(walletId) ? await this.db.wallets.findById(walletId) : undefined;
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  async getLedger(walletId: string, cursor: string | undefined, limitParam: string | undefined) {
    await this.getWallet(walletId);
    const limit = limitParam === undefined ? 50 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError('limit must be an integer between 1 and 200');
    }
    const page = await this.db.ledger.page(walletId, decodeCursor(cursor), limit);
    return {
      items: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.hasMore && page.lastSeq ? encodeCursor(page.lastSeq) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = UUID.test(transactionId) ? await this.db.transactions.findById(transactionId) : undefined;
    if (!tx) throw new TransactionNotFoundError();
    return tx;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.db.transactions.findByExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError();
    return tx;
  }

  /**
   * Compara o saldo materializado (wallets.balance) com o saldo reconstruído
   * pelo ledger. FOR SHARE garante uma foto consistente (ninguém altera a
   * wallet enquanto contamos). Divergência NÃO é corrigida: é logada,
   * contada em métrica e sinalizada na resposta.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    if (!UUID.test(walletId)) throw new WalletNotFoundError(walletId);
    const report = await this.db.transaction(async (tx) => {
      const wallet = await tx.wallets.lockForShare(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const { balance: calculated, entries } = await tx.ledger.calculatedBalance(walletId, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries,
      };
    });
    if (!report.consistent) {
      this.metrics.reconciliationMismatches.inc();
      this.logger.error('wallet reconciliation mismatch', { walletId, checkedEntries: report.checkedEntries });
    }
    return report;
  }
}

// O cursor é "opaco" para o cliente: base64url de {"s":"<seq>"}.
function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const { s } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof s === 'string' && /^\d{1,19}$/.test(s)) return s;
  } catch {
    /* cai no erro abaixo */
  }
  throw new ValidationError('invalid cursor');
}
