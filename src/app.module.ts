import {
  BeforeApplicationShutdown,
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { CreateWalletService } from './application/create-wallet.service';
import { ProcessWagerService } from './application/process-wager.service';
import { WalletQueriesService } from './application/wallet-queries.service';
import type { AppConfig } from './config';
import { CONFIG, HealthController, WageringController, WalletsController } from './http/controllers';
import { Database } from './infrastructure/database/database';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway';
import { WagerQueueConsumer } from './infrastructure/messaging/wager-queue-consumer';
import { JsonLogger } from './infrastructure/observability/logger';
import { Metrics } from './infrastructure/observability/metrics';
import { OutboxPublisher } from './infrastructure/workers/outbox-publisher';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { PeriodicWorker } from './infrastructure/workers/periodic-worker';

/** Liga/desliga consumidor e workers junto com a aplicação (inclui SIGTERM). */
@Injectable()
class AppLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly workers: PeriodicWorker[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(WagerQueueConsumer) private readonly consumer: WagerQueueConsumer,
    @Inject(OutboxPublisher) private readonly outbox: OutboxPublisher,
    @Inject(PendingReferenceWorker) private readonly pending: PendingReferenceWorker,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { workers } = this.config;
    if (this.config.sqsAutoCreate && (workers.consumer || workers.outbox)) {
      await this.sqs.ensureQueues(this.config.queues, this.config.sqsMaxReceives);
    }
    if (workers.consumer) this.consumer.start();
    if (workers.outbox) {
      this.workers.push(
        // lote cheio = provavelmente há mais pendentes: roda de novo sem esperar
        new PeriodicWorker(
          'outbox-publisher',
          500,
          async () => (await this.outbox.publishBatch()) >= this.outbox.batchSize,
          this.logger,
        ),
      );
    }
    if (workers.pendingReference) {
      this.workers.push(new PeriodicWorker('pending-reference', 1000, () => this.pending.runOnce(), this.logger));
    }
    this.workers.forEach((w) => w.start());
    this.logger.info('workers started', { ...workers });
  }

  /** 1º passo do shutdown: para de pegar trabalho novo e termina o que está em andamento. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info('shutting down', { signal });
    await Promise.all([this.consumer.stop(), ...this.workers.map((w) => w.stop())]);
  }

  /** 2º passo: fecha conexões. */
  async onApplicationShutdown(): Promise<void> {
    this.sqs.close();
    await this.db.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger = new JsonLogger()): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: JsonLogger, useValue: logger },
        { provide: Metrics, useValue: new Metrics(true) },
        {
          provide: Database,
          useFactory: async (metrics: Metrics) => {
            const db = await Database.connect({
              url: config.databaseUrl,
              poolMax: config.dbPoolMax,
              lockTimeoutMs: config.lockTimeoutMs,
            });
            metrics.outboxLagReader = () => db.outbox.lagSeconds();
            return db;
          },
          inject: [Metrics],
        },
        { provide: SqsGateway, useFactory: () => new SqsGateway(config.aws) },
        {
          provide: ProcessWagerService,
          useFactory: (db: Database, m: Metrics, l: JsonLogger) => new ProcessWagerService(db, m, l),
          inject: [Database, Metrics, JsonLogger],
        },
        {
          provide: CreateWalletService,
          useFactory: (db: Database, l: JsonLogger) => new CreateWalletService(db, l),
          inject: [Database, JsonLogger],
        },
        {
          provide: WalletQueriesService,
          useFactory: (db: Database, m: Metrics, l: JsonLogger) => new WalletQueriesService(db, m, l),
          inject: [Database, Metrics, JsonLogger],
        },
        {
          provide: WagerQueueConsumer,
          useFactory: (sqs: SqsGateway, pw: ProcessWagerService, m: Metrics, l: JsonLogger) =>
            new WagerQueueConsumer(sqs, pw, m, l, {
              queue: config.queues.wager,
              dlq: config.queues.dlq,
              consumerName: config.consumerName,
              maxReceives: config.sqsMaxReceives,
            }),
          inject: [SqsGateway, ProcessWagerService, Metrics, JsonLogger],
        },
        {
          provide: OutboxPublisher,
          useFactory: (db: Database, sqs: SqsGateway, m: Metrics, l: JsonLogger) =>
            new OutboxPublisher(db, sqs, m, l, { queue: config.queues.events }),
          inject: [Database, SqsGateway, Metrics, JsonLogger],
        },
        {
          provide: PendingReferenceWorker,
          useFactory: (db: Database, pw: ProcessWagerService, l: JsonLogger) => new PendingReferenceWorker(db, pw, l),
          inject: [Database, ProcessWagerService, JsonLogger],
        },
        AppLifecycle,
      ],
    };
  }
}
