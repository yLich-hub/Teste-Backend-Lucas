import type { Message } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { AppError } from '../../application/errors';
import { ProcessWagerService } from '../../application/process-wager.service';
import { canonicalJson, parseWagerCommand, sha256, WagerCommand } from '../../application/wager-command';
import { DomainError } from '../../domain/errors';
import { errorInfo, JsonLogger } from '../observability/logger';
import { Metrics } from '../observability/metrics';
import { SqsGateway } from './sqs-gateway';

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime(),
  correlationId: z.string().optional(),
  data: z.record(z.unknown()),
});

/**
 * Decisão sobre a mensagem:
 *  - ack   : processou (inclusive REJECTED/PENDING_REFERENCE) ou era duplicata -> apaga da fila
 *  - retry : erro transitório -> devolve à fila com backoff (visibility timeout)
 *  - dlq   : erro permanente (payload inválido, conflito) -> manda para a DLQ e apaga
 */
export type Decision = { action: 'ack' } | { action: 'retry' } | { action: 'dlq'; reason: string };

export interface ConsumerOptions {
  queue: string;
  dlq: string;
  consumerName: string;
  maxReceives: number;
  waitSeconds?: number;
  visibilityTimeout?: number;
}

export class WagerQueueConsumer {
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerService,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
    private readonly opts: ConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * SIGTERM: para de buscar mensagens novas, cancela o long-poll e espera as
   * mensagens em andamento terminarem (commit + ack). Nada fica pela metade:
   * o que não foi confirmado volta a ficar visível na fila sozinho.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.abort = new AbortController();
      try {
        const messages = await this.sqs.receive(this.opts.queue, {
          max: 10,
          waitSeconds: this.opts.waitSeconds ?? 10,
          visibilityTimeout: this.opts.visibilityTimeout,
          signal: this.abort.signal,
        });
        await Promise.all(messages.map((m) => this.handle(m)));
      } catch (err) {
        if (!this.running) break; // abort do shutdown
        this.logger.warn('sqs receive failed', errorInfo(err));
        await sleep(1000);
      }
    }
  }

  /** Processa e só então confirma (ack depois do commit). */
  async handle(message: Message): Promise<Decision> {
    const decision = await this.process(message);
    await this.settle(message, decision);
    return decision;
  }

  /** Executa o use case e classifica o resultado. NÃO faz ack (separado para testarmos crash antes do ack). */
  async process(message: Message): Promise<Decision> {
    let command: WagerCommand;
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(message.Body ?? ''));
      const { idempotencyKey, ...body } = envelope.data;
      command = parseWagerCommand(body, idempotencyKey);
    } catch (err) {
      this.logger.warn('invalid wager message', { sqsMessageId: message.MessageId, ...errorInfo(err) });
      return { action: 'dlq', reason: 'INVALID_MESSAGE' };
    }

    const logCtx = {
      messageId: envelope.messageId,
      correlationId: envelope.correlationId ?? envelope.messageId,
      walletId: command.walletId,
      providerId: command.providerId,
    };
    try {
      const outcome = await this.processWager.execute(command, {
        correlationId: logCtx.correlationId,
        source: 'sqs',
        inbox: {
          consumerName: this.opts.consumerName,
          messageId: envelope.messageId,
          payloadHash: sha256(canonicalJson(envelope.data)),
        },
      });
      if (outcome.duplicateMessage) this.logger.info('duplicate message ignored (inbox)', logCtx);
      return { action: 'ack' };
    } catch (err) {
      if (err instanceof DomainError || (err instanceof AppError && err.category !== 'transient')) {
        this.logger.warn('permanent failure processing message', { ...logCtx, code: err.code });
        return { action: 'dlq', reason: err.code };
      }
      this.logger.warn('transient failure processing message', { ...logCtx, ...errorInfo(err) });
      return { action: 'retry' };
    }
  }

  async settle(message: Message, decision: Decision): Promise<void> {
    const receipt = message.ReceiptHandle!;
    try {
      if (decision.action === 'ack') {
        await this.sqs.delete(this.opts.queue, receipt);
        return;
      }
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      if (decision.action === 'retry' && receiveCount < this.opts.maxReceives) {
        // backoff exponencial: 2s, 4s, 8s ... (máx. 5 min)
        const delay = Math.min(2 ** receiveCount, 300);
        this.metrics.sqsRetries.inc();
        await this.sqs.changeVisibility(this.opts.queue, receipt, delay);
        return;
      }
      const reason = decision.action === 'dlq' ? decision.reason : 'MAX_RECEIVES_EXCEEDED';
      await this.sqs.send(this.opts.dlq, message.Body ?? '', {
        groupId: message.Attributes?.MessageGroupId ?? 'dlq',
        deduplicationId: message.MessageId,
        attributes: { failureReason: reason, receiveCount: String(receiveCount) },
      });
      await this.sqs.delete(this.opts.queue, receipt);
      this.metrics.sqsDlq.inc({ reason });
      this.logger.warn('message sent to DLQ', { sqsMessageId: message.MessageId, reason });
    } catch (err) {
      // Se o ack falhar, a mensagem volta a ficar visível e o inbox evita efeito duplicado.
      this.logger.error('failed to settle sqs message', { sqsMessageId: message.MessageId, ...errorInfo(err) });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
