import { Migrator } from '@mikro-orm/migrations';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientError } from '../../application/errors';
import { Migration20261113000000_initial } from './migrations/Migration20261113000000_initial';
import { Migration20261114000000_outbox_lease } from './migrations/Migration20261114000000_outbox_lease';
import { InboxRepository } from './repositories/inbox.repository';
import { LedgerRepository } from './repositories/ledger.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import { WagerTransactionRepository } from './repositories/wager-transaction.repository';
import { WalletRepository } from './repositories/wallet.repository';

export type Row = Record<string, any>;

/** Qualquer coisa capaz de executar SQL: o pool (Database) ou uma transação (Tx). */
export interface SqlRunner {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Uma transação SQL aberta. Os repositórios pendurados aqui compartilham a
 * MESMA conexão/transação: inbox, transação, wallet, ledger e outbox são
 * confirmados juntos no COMMIT ou descartados juntos no ROLLBACK.
 */
export class Tx implements SqlRunner {
  readonly wallets = new WalletRepository(this);
  readonly transactions = new WagerTransactionRepository(this);
  readonly ledger = new LedgerRepository(this);
  readonly inbox = new InboxRepository(this);
  readonly outbox = new OutboxRepository(this);

  constructor(private readonly em: EntityManager) {}

  query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.em.execute(sql, params as any[]) as Promise<T[]>;
  }
}

export const MIGRATIONS = [
  { name: 'Migration20261113000000_initial', class: Migration20261113000000_initial },
  { name: 'Migration20261114000000_outbox_lease', class: Migration20261114000000_outbox_lease },
];

/**
 * Acesso ao PostgreSQL via MikroORM.
 *
 * Usamos o MikroORM para: pool de conexões, `em.transactional()` (BEGIN/COMMIT/
 * ROLLBACK) e migrations versionadas e reversíveis. As queries críticas
 * (lock da wallet, ON CONFLICT, SKIP LOCKED) são SQL explícito para que a
 * estratégia de concorrência fique visível na revisão.
 */
export class Database implements SqlRunner {
  readonly wallets = new WalletRepository(this);
  readonly transactions = new WagerTransactionRepository(this);
  readonly ledger = new LedgerRepository(this);
  /** Fora de transação: cada comando da outbox (claim/marcar) é atômico sozinho. */
  readonly outbox = new OutboxRepository(this);

  private constructor(
    readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  static async connect(opts: { url: string; poolMax?: number; lockTimeoutMs?: number }): Promise<Database> {
    const orm = await MikroORM.init({
      clientUrl: opts.url,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      extensions: [Migrator],
      migrations: {
        migrationsList: MIGRATIONS,
        transactional: true,
        allOrNothing: true,
        snapshot: false,
      },
      pool: { min: 0, max: opts.poolMax ?? 20 },
      allowGlobalContext: false,
      debug: false,
    });
    return new Database(orm, opts.lockTimeoutMs ?? 5000);
  }

  /**
   * Executa `fn` dentro de uma transação SQL. Erros de infraestrutura
   * (conexão, lock timeout, deadlock) viram TransientError.
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Não esperar para sempre por uma wallet "quente": falha transitória e o chamador tenta de novo.
        await em.execute(`set local lock_timeout = ${Math.trunc(this.lockTimeoutMs)}`);
        return fn(new Tx(em));
      });
    } catch (err) {
      throw asTransientIfInfra(err);
    }
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return (await this.orm.em.fork().execute(sql, params as any[])) as T[];
    } catch (err) {
      throw asTransientIfInfra(err);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}

// ------------------------------------------------------------- erros do Postgres

/** SQLSTATE do erro original do driver `pg` (o MikroORM embrulha o erro). */
export function sqlState(err: unknown): string | undefined {
  const e = err as any;
  return e?.code ?? e?.sqlState ?? e?.cause?.code ?? e?.previous?.code;
}

export function constraintName(err: unknown): string | undefined {
  const e = err as any;
  return e?.constraint ?? e?.cause?.constraint ?? e?.previous?.constraint;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return sqlState(err) === '23505' && (!constraint || constraintName(err) === constraint);
}

const TRANSIENT_STATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export function isTransientDbError(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  const state = sqlState(err);
  if (state && (TRANSIENT_STATES.has(state) || state.startsWith('08'))) return true;
  if (state && TRANSIENT_NODE_CODES.has(state)) return true;
  const e = err as any;
  const text = `${e?.name ?? ''} ${e?.message ?? ''}`;
  return /KnexTimeoutError|Timeout acquiring a connection|Connection terminated|ECONNREFUSED/i.test(text);
}

export function isLockConflict(err: unknown): boolean {
  const state = sqlState((err as any)?.cause ?? err);
  return state === '55P03' || state === '40P01' || state === '40001';
}

function asTransientIfInfra(err: unknown): unknown {
  if (!(err instanceof TransientError) && isTransientDbError(err)) {
    return new TransientError('database temporarily unavailable', err);
  }
  return err;
}
