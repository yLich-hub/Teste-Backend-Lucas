import { ConcurrencyError } from '../concurrency-error';
import type { Row, SqlRunner } from '../database';
import { Money } from '../../../domain/money';
import { Wallet } from '../../../domain/wallet';

const COLUMNS = 'id, player_id, currency, balance::text as balance, version, created_at, updated_at';

export class WalletRepository {
  constructor(private readonly db: SqlRunner) {}

  async insert(w: Wallet): Promise<void> {
    await this.db.query(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [w.id, w.playerId, w.currency, w.balance.toString(), w.version, w.createdAt, w.updatedAt],
    );
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const [row] = await this.db.query(`select ${COLUMNS} from wallets where id = ?`, [id]);
    return row ? toWallet(row) : undefined;
  }

  /**
   * SELECT ... FOR UPDATE: trava SÓ esta linha até o fim da transação.
   * Outra instância que tente travar a mesma wallet espera (fila por wallet);
   * wallets diferentes seguem em paralelo. É o nosso controle de concorrência.
   */
  async lockById(id: string): Promise<Wallet | undefined> {
    const [row] = await this.db.query(`select ${COLUMNS} from wallets where id = ? for update`, [id]);
    return row ? toWallet(row) : undefined;
  }

  /** FOR SHARE: impede alterações enquanto lemos (usado na reconciliação). */
  async lockForShare(id: string): Promise<Wallet | undefined> {
    const [row] = await this.db.query(`select ${COLUMNS} from wallets where id = ? for share`, [id]);
    return row ? toWallet(row) : undefined;
  }

  /**
   * Grava saldo e versão. O `where version = expectedVersion` é uma segunda
   * barreira (optimistic check): com o lock ele nunca falha, mas se alguém
   * esquecer o lock no futuro, o update não sobrescreve nada em silêncio.
   */
  async update(w: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.db.query(
      `update wallets set balance = ?, version = ?, updated_at = ?
        where id = ? and version = ? returning id`,
      [w.balance.toString(), w.version, w.updatedAt, w.id, expectedVersion],
    );
    if (rows.length !== 1) throw new ConcurrencyError(`wallet ${w.id} was modified concurrently`);
  }
}

function toWallet(row: Row): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}
