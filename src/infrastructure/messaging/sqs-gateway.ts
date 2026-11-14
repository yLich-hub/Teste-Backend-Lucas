import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export interface OutgoingMessage {
  body: string;
  groupId?: string;
  deduplicationId?: string;
  attributes?: Record<string, string>;
}

/** O SQS aceita no máximo 10 mensagens por SendMessageBatch. */
export const SQS_BATCH_LIMIT = 10;

function messageAttributes(attributes: Record<string, string> = {}) {
  return Object.fromEntries(
    Object.entries(attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
  );
}

/** Envoltório fino sobre o SDK do SQS (LocalStack/MiniStack/AWS). */
export class SqsGateway {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(aws: AppConfig['aws']) {
    this.client = new SQSClient({
      region: aws.region,
      endpoint: aws.endpoint,
      credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
    });
  }

  async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const res = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    this.urls.set(name, res.QueueUrl!);
    return res.QueueUrl!;
  }

  /**
   * Cria as filas se não existirem (idempotente). A fila principal tem
   * redrive para a DLQ como rede de segurança: se o processo morrer repetidamente
   * no meio de uma mensagem, o próprio SQS a move para a DLQ.
   */
  async ensureQueues(queues: AppConfig['queues'], maxReceives: number, visibilityTimeoutSec = 30): Promise<void> {
    const dlqUrl = await this.createQueue(queues.dlq, {});
    const dlqArn = (
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
    ).Attributes!.QueueArn!;
    await this.createQueue(queues.wager, {
      VisibilityTimeout: String(visibilityTimeoutSec),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceives + 1) }),
    });
    await this.createQueue(queues.events, {});
  }

  async send(
    queueName: string,
    body: string,
    opts: { groupId?: string; deduplicationId?: string; attributes?: Record<string, string> } = {},
  ): Promise<void> {
    const fifo = queueName.endsWith('.fifo');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MessageBody: body,
        MessageGroupId: fifo ? (opts.groupId ?? 'default') : undefined,
        MessageDeduplicationId: fifo ? opts.deduplicationId : undefined,
        MessageAttributes: messageAttributes(opts.attributes),
      }),
    );
  }

  /**
   * Envia até 10 mensagens numa única chamada (SendMessageBatch).
   * O SQS pode aceitar parte e recusar parte: devolvemos o índice de cada
   * mensagem que FALHOU, para o chamador reagendar só essas.
   */
  async sendBatch(queueName: string, messages: OutgoingMessage[]): Promise<Set<number>> {
    if (messages.length === 0) return new Set();
    if (messages.length > SQS_BATCH_LIMIT) throw new Error(`max ${SQS_BATCH_LIMIT} messages per batch`);
    const fifo = queueName.endsWith('.fifo');
    const res = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.queueUrl(queueName),
        Entries: messages.map((m, i) => ({
          Id: String(i),
          MessageBody: m.body,
          MessageGroupId: fifo ? (m.groupId ?? 'default') : undefined,
          MessageDeduplicationId: fifo ? m.deduplicationId : undefined,
          MessageAttributes: messageAttributes(m.attributes),
        })),
      }),
    );
    return new Set((res.Failed ?? []).map((f) => Number(f.Id)));
  }

  async receive(
    queueName: string,
    opts: { max?: number; waitSeconds?: number; visibilityTimeout?: number; signal?: AbortSignal } = {},
  ): Promise<Message[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MaxNumberOfMessages: opts.max ?? 10,
        WaitTimeSeconds: opts.waitSeconds ?? 10,
        VisibilityTimeout: opts.visibilityTimeout,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: opts.signal },
    );
    return res.Messages ?? [];
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: await this.queueUrl(queueName), ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(queueName: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async isHealthy(queueName: string): Promise<boolean> {
    try {
      this.urls.delete(queueName);
      await this.queueUrl(queueName);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.client.destroy();
  }

  private async createQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const fifo = name.endsWith('.fifo');
    try {
      const res = await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { ...attributes, ...(fifo ? { FifoQueue: 'true', ContentBasedDeduplication: 'false' } : {}) },
        }),
      );
      this.urls.set(name, res.QueueUrl!);
      return res.QueueUrl!;
    } catch (err) {
      // Já existe com atributos diferentes: usamos a existente.
      if ((err as any)?.name?.includes('QueueAlreadyExists') || (err as any)?.name?.includes('QueueNameExists')) {
        return this.queueUrl(name);
      }
      throw err;
    }
  }
}
