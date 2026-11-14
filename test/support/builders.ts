import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

export const NOW = new Date('2026-11-13T12:00:00.000Z');
export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export function aWallet(balance = '100.00', playerId = PLAYER): Wallet {
  return Wallet.open({ id: randomUUID(), playerId, initialBalance: brl(balance), at: NOW });
}

export function aTransaction(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${randomUUID()}`;
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'h'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: NOW,
    ...overrides,
  });
}

/** Uma transação já PROCESSED (para servir de referência). */
export function processed(tx: WagerTransaction, wallet: Wallet): WagerTransaction {
  tx.markProcessed(undefined, NOW, wallet.balance);
  return tx;
}
