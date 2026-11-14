import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { OutboxMessage } from '../../domain/outbox-message';
import { Database } from '../database/database';
import { SQS_BATCH_LIMIT, SqsGateway } from '../messaging/sqs-gateway';
import { errorInfo, JsonLogger } from '../observability/logger';
import { Metrics } from '../observability/metrics';

export interface OutboxPublisherOptions {
  queue: string;
  /** quantos eventos alugar por ciclo (default 100) */
  batchSize?: number;
  /** quanto tempo o lote fica "alugado" para esta instância (default 30s) */
  leaseMs?: number;
  /** identificador desta instância (default: hostname + uuid) */
  owner?: string;
}

export const DEFAULT_OUTBOX_BATCH = 100;

/**
 * Publica os eventos da outbox com LEASE. Pode rodar em N instâncias:
 *
 *  1. claim: UPDATE ... locked_by = eu, locked_until = agora + 30s
 *            WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)   -> commit imediato
 *  2. publica no SQS sem transação aberta no banco: o lote é dividido em
 *     pedaços de 10 (limite do SendMessageBatch) enviados EM PARALELO.
 *     100 eventos = 10 chamadas simultâneas, em vez de 100 chamadas em fila.
 *  3. release: um único UPDATE marca published_at de todos os que deram certo;
 *     os que falharam são reagendados com backoff.
 *
 * Se o processo morrer entre 1 e 3, ninguém marca o evento; quando o aluguel
 * vence, outra instância o pega e publica de novo. Isso é "at-least-once": o
 * evento pode sair duplicado, mas carrega o mesmo `eventId`, e o consumidor
 * descarta repetidos. O que nunca acontece é publicar algo que não foi
 * commitado: a linha da outbox só existe depois do commit da transação financeira.
 *
 * Ordem: a fila de eventos é standard (sem ordem garantida). Quem precisa de
 * ordem por wallet usa `walletVersion` do WalletBalanceChanged.
 */
export class OutboxPublisher {
  private readonly owner: string;
  readonly batchSize: number;

  constructor(
    private readonly db: Database,
    private readonly sqs: SqsGateway,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
    private readonly opts: OutboxPublisherOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.owner = opts.owner ?? `${hostname()}:${randomUUID().slice(0, 8)}`;
    this.batchSize = opts.batchSize ?? DEFAULT_OUTBOX_BATCH;
  }

  /** Publica um lote. Devolve quantas mensagens foram tratadas. */
  async publishBatch(): Promise<number> {
    const batch = await this.db.outbox.claimDueBatch(
      this.owner,
      this.clock(),
      this.batchSize,
      this.opts.leaseMs ?? 30_000,
    );
    if (batch.length === 0) return 0;

    const chunks: OutboxMessage[][] = [];
    for (let i = 0; i < batch.length; i += SQS_BATCH_LIMIT) chunks.push(batch.slice(i, i + SQS_BATCH_LIMIT));
    const results = await Promise.all(chunks.map((chunk) => this.sendChunk(chunk)));

    const published = results.flatMap((r) => r.published);
    const failed = results.flatMap((r) => r.failed);

    const now = this.clock();
    published.forEach((m) => m.markPublished(now));
    const released = await this.db.outbox.releasePublished(
      published.map((m) => m.id),
      this.owner,
      now,
    );
    if (released < published.length) {
      // Aluguel venceu no meio do caminho e outra instância assumiu parte do lote.
      // Sem problema: no pior caso o evento sai duas vezes, com o mesmo eventId.
      this.logger.warn('outbox lease lost for some events', { lost: published.length - released });
    }
    this.metrics.outboxPublished.inc(published.length);

    for (const message of failed) {
      message.scheduleRetry(now);
      await this.db.outbox.release(message, this.owner);
    }
    if (failed.length) this.metrics.outboxPublishFailures.inc(failed.length);

    return batch.length;
  }

  private async sendChunk(chunk: OutboxMessage[]): Promise<{ published: OutboxMessage[]; failed: OutboxMessage[] }> {
    try {
      const failedIdx = await this.sqs.sendBatch(
        this.opts.queue,
        chunk.map((m) => ({
          body: JSON.stringify(m.payload),
          groupId: m.aggregateId,
          deduplicationId: m.id,
          attributes: { eventType: m.eventType, eventId: m.id },
        })),
      );
      if (failedIdx.size) this.logger.warn('outbox batch partially failed', { failed: failedIdx.size });
      return {
        published: chunk.filter((_, i) => !failedIdx.has(i)),
        failed: chunk.filter((_, i) => failedIdx.has(i)),
      };
    } catch (err) {
      this.logger.warn('outbox publish failed, will retry', { events: chunk.length, ...errorInfo(err) });
      return { published: [], failed: chunk };
    }
  }
}
