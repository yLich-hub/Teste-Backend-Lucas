import type { Row, SqlRunner } from '../database';
import { OutboxMessage } from '../../../domain/outbox-message';

export class OutboxRepository {
  constructor(private readonly db: SqlRunner) {}

  /** Chamado DENTRO da transação financeira: o evento existe se e somente se o commit acontecer. */
  async insert(m: OutboxMessage): Promise<void> {
    await this.db.query(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       values (?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
      [
        m.id,
        m.aggregateId,
        m.eventType,
        JSON.stringify(m.payload),
        m.occurredAt,
        m.attempts,
        m.nextAttemptAt ?? null,
        m.publishedAt ?? null,
      ],
    );
  }

  /**
   * "Aluga" (lease) um lote de eventos pendentes para `owner` por `leaseMs`.
   * É UM comando SQL, atômico por si só:
   *  - o SELECT interno usa FOR UPDATE SKIP LOCKED: dois publishers rodando ao
   *    mesmo tempo nunca pegam a mesma linha (cada um pula as do outro);
   *  - só entra linha sem aluguel ou com aluguel VENCIDO (dono morreu).
   * Depois do commit deste comando nenhuma transação fica aberta: a publicação
   * no SQS acontece fora do banco.
   */
  async claimDueBatch(owner: string, now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.db.query(
      `update outbox_messages
          set locked_by = ?, locked_until = now() + (? * interval '1 millisecond')
        where id in (
          select id from outbox_messages
           where published_at is null
             and next_attempt_at <= ?
             and (locked_until is null or locked_until < now())
           order by occurred_at
           limit ?
           for update skip locked)
        returning *`,
      [owner, leaseMs, now, limit],
    );
    return rows.map(toOutbox).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  /**
   * Grava o resultado da tentativa (publicado ou reagendado) e devolve o aluguel.
   * O `locked_by = owner` impede que um publisher "atrasado", cujo aluguel já
   * venceu e foi pego por outro, sobrescreva o estado. Devolve false nesse caso.
   */
  async release(m: OutboxMessage, owner: string): Promise<boolean> {
    const rows = await this.db.query(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, published_at = ?, locked_by = null, locked_until = null
        where id = ? and locked_by = ?
        returning id`,
      [m.attempts, m.nextAttemptAt ?? null, m.publishedAt ?? null, m.id, owner],
    );
    return rows.length === 1;
  }

  /**
   * Versão em massa do `release` para o caso comum (tudo publicado): UM UPDATE
   * para o lote inteiro em vez de um por evento. Mesma proteção `locked_by = owner`.
   * Devolve quantas linhas ainda eram deste dono.
   */
  async releasePublished(ids: string[], owner: string, at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.query(
      `update outbox_messages
          set published_at = ?, next_attempt_at = null, locked_by = null, locked_until = null
        where id in (${ids.map(() => '?').join(',')}) and locked_by = ?
        returning id`,
      [at, ...ids, owner],
    );
    return rows.length;
  }

  /** Idade (em segundos) do evento pendente mais antigo: métrica de "outbox lag". */
  async lagSeconds(): Promise<number> {
    const [row] = await this.db.query(
      `select coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag
         from outbox_messages where published_at is null`,
    );
    return Number(row?.lag ?? 0);
  }
}

function toOutbox(row: Row): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
    publishedAt: row.published_at ? new Date(row.published_at) : undefined,
  });
}
