import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../domain/errors';
import { EventContext, WagerTransactionProcessed, WalletBalanceChanged } from '../domain/integration-events';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { Database, isUniqueViolation } from '../infrastructure/database/database';
import { JsonLogger } from '../infrastructure/observability/logger';
import { WalletAlreadyExistsError } from './errors';
import { canonicalJson, sha256 } from './wager-command';

const createWalletSchema = z
  .object({
    playerId: z.string().trim().min(1).max(200),
    initialBalance: z.object({ amount: z.string(), currency: z.string() }).strict(),
  })
  .strict();

export const INTERNAL_PROVIDER = 'internal';

export class CreateWalletService {
  constructor(
    private readonly db: Database,
    private readonly logger: JsonLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Cria a wallet. Se o saldo inicial for > 0, NA MESMA transação SQL cria a
   * transação interna OPENING, o lançamento CREDIT no ledger e os eventos.
   */
  async execute(body: unknown, correlationId: string): Promise<Wallet> {
    const parsed = createWalletSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new ValidationError(`${issue.path.join('.') || 'body'}: ${issue.message}`);
    }
    const initialBalance = Money.from(parsed.data.initialBalance);
    const now = this.clock();
    const wallet = Wallet.open({ id: randomUUID(), playerId: parsed.data.playerId, initialBalance, at: now });

    try {
      await this.db.transaction(async (tx) => {
        await tx.wallets.insert(wallet); // UNIQUE (player_id, currency) barra duplicadas

        if (initialBalance.isPositive()) {
          const opening = WagerTransaction.create({
            id: randomUUID(),
            providerId: INTERNAL_PROVIDER,
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: sha256(canonicalJson({ walletId: wallet.id, money: initialBalance.toJSON() })),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: now,
          });
          opening.markProcessed(undefined, now, wallet.balance);
          const entry = wallet.openingEntry(opening.id);
          const ctx: EventContext = { correlationId, causationId: wallet.id, occurredAt: now };

          await tx.transactions.insert(opening);
          await tx.ledger.insert(entry);
          await tx.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)));
          await tx.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)));
        }
      });
    } catch (err) {
      if (isUniqueViolation(err, 'wallets_player_currency_uq')) throw new WalletAlreadyExistsError();
      throw err;
    }

    this.logger.info('wallet created', { correlationId, walletId: wallet.id });
    return wallet;
  }
}
