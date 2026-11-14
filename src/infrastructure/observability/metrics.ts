import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Métricas Prometheus expostas em GET /metrics. */
export class Metrics {
  readonly registry = new Registry();

  readonly transactionsByStatus = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas, por status final e kind',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicatas detectadas (replay idempotente HTTP/SQS ou mensagem repetida no inbox)',
    labelNames: ['source'],
    registers: [this.registry],
  });
  readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Mesma idempotency key com payload diferente',
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Lock timeout / deadlock / conflito de versão ao travar a wallet',
    registers: [this.registry],
  });
  readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Tempo esperando o lock da wallet (hot wallet)',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [this.registry],
  });
  readonly processingLatency = new Histogram({
    name: 'wager_processing_seconds',
    help: 'Latência do processamento de uma transação (inclui o commit)',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly sqsRetries = new Counter({
    name: 'sqs_message_retries_total',
    help: 'Mensagens devolvidas à fila para nova tentativa (erro transitório)',
    registers: [this.registry],
  });
  readonly sqsDlq = new Counter({
    name: 'sqs_messages_dead_lettered_total',
    help: 'Mensagens enviadas à DLQ',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados a partir da outbox',
    registers: [this.registry],
  });
  readonly outboxPublishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas de publicação (serão re-tentadas com backoff)',
    registers: [this.registry],
  });
  /** Lido do banco a cada coleta de /metrics (funciona mesmo se o publisher estiver parado). */
  outboxLagReader?: () => Promise<number>;
  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo na outbox',
    registers: [this.registry],
    collect: async () => {
      if (!this.outboxLagReader) return;
      try {
        this.outboxLag.set(await this.outboxLagReader());
      } catch {
        /* banco fora: mantém o último valor; o /health/ready denuncia o problema */
      }
    },
  });
  readonly referenceRetries = new Counter({
    name: 'pending_reference_retries_total',
    help: 'Tentativas do worker de resolver referências pendentes',
    registers: [this.registry],
  });
  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Reconciliações em que saldo materializado != saldo do ledger',
    registers: [this.registry],
  });

  constructor(collectDefaults = false) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }
}
