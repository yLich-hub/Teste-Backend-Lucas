/** Configuração lida das variáveis de ambiente (com defaults para o docker-compose local). */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  /** espera máxima pelo lock da wallet antes de desistir com erro transitório */
  lockTimeoutMs: number;
  aws: { region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string };
  queues: { wager: string; dlq: string; events: string };
  sqsAutoCreate: boolean;
  /** tentativas de uma mensagem SQS com erro transitório antes de ir para a DLQ */
  sqsMaxReceives: number;
  consumerName: string;
  workers: { consumer: boolean; outbox: boolean; pendingReference: boolean };
}

const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : v === 'true' || v === '1');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
    dbPoolMax: Number(env.DB_POOL_MAX ?? 20),
    lockTimeoutMs: Number(env.LOCK_TIMEOUT_MS ?? 5000),
    aws: {
      region: env.AWS_REGION ?? 'us-east-1',
      endpoint: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    queues: {
      wager: env.WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
      dlq: env.WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
      events: env.EVENTS_QUEUE_NAME ?? 'wallet-events',
    },
    sqsAutoCreate: bool(env.SQS_AUTO_CREATE, true),
    sqsMaxReceives: Number(env.SQS_MAX_RECEIVES ?? 5),
    consumerName: env.CONSUMER_NAME ?? 'wager-transactions-consumer',
    workers: {
      consumer: bool(env.WORKER_CONSUMER, true),
      outbox: bool(env.WORKER_OUTBOX, true),
      pendingReference: bool(env.WORKER_PENDING_REFERENCE, true),
    },
  };
}
