import { IntegrationEvent } from './integration-events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/**
 * Evento esperando publicação. É gravado NA MESMA transação SQL da alteração
 * financeira (Transactional Outbox): se o commit acontece, o evento existe;
 * se dá rollback, o evento some junto. Um worker publica depois do commit.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // id da outbox = eventId: a publicação duplicada leva o mesmo id ao consumidor.
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt (1s, 2s, 4s ... máx. 60s) */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(BASE_RETRY_MS * 2 ** (this._attempts - 1), MAX_RETRY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
