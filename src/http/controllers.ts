import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreateWalletService } from '../application/create-wallet.service';
import { ProcessWagerService, WagerResult } from '../application/process-wager.service';
import { parseWagerCommand } from '../application/wager-command';
import { WalletQueriesService } from '../application/wallet-queries.service';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { AppConfig } from '../config';
import { Database } from '../infrastructure/database/database';
import { SqsGateway } from '../infrastructure/messaging/sqs-gateway';
import { Metrics } from '../infrastructure/observability/metrics';
import { ProviderAuthGuard } from './auth.guard';

export const CONFIG = Symbol('CONFIG');

const correlation = (header?: string) => (header && header.length <= 200 ? header : randomUUID());

/**
 * Status HTTP de uma transação de aposta (mesmo código no replay):
 *   200 PROCESSED | 202 PENDING_REFERENCE | 422 REJECTED (failureCode no corpo) | 500 FAILED
 */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletService) private readonly createWallet: CreateWalletService,
    @Inject(WalletQueriesService) private readonly queries: WalletQueriesService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlationId?: string) {
    return walletView(await this.createWallet.execute(body, correlation(correlationId)));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.queries.getLedger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.queries.reconcile(walletId);
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerService) private readonly processWager: ProcessWagerService,
    @Inject(WalletQueriesService) private readonly queries: WalletQueriesService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const command = parseWagerCommand(body, idempotencyKey);
    const outcome = await this.processWager.execute(command, {
      correlationId: correlation(correlationId),
      source: 'http',
    });
    if (outcome.duplicateMessage) throw new Error('unreachable: HTTP has no inbox');
    const { duplicateMessage: _ignored, ...result } = outcome;
    res.status(STATUS_CODE[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') id: string) {
    return transactionView(await this.queries.getTransaction(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return transactionView(await this.queries.getTransactionByExternalId(providerId, externalId));
  }
}

/** Sem autenticação (seção 2 do README). */
@Controller()
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([this.db.isHealthy(), this.sqs.isHealthy(this.config.queues.wager)]);
    const ok = postgres && sqs;
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  @Get('metrics')
  async metricsText(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

function walletView(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function transactionView(t: WagerTransaction) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    status: t.status,
    failureCode: t.failureCode,
    balance: t.balanceAfter?.toJSON(),
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString(),
  };
}
