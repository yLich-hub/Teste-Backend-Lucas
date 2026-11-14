import { describe, expect, test } from 'bun:test';
import { FailureCode, InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { aTransaction, aWallet, NOW } from '../support/builders';

describe('WagerTransaction', () => {
  const wallet = aWallet();

  test('nasce PENDING', () => {
    expect(aTransaction(wallet, K.Bet, '10.00').status).toBe(S.Pending);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => aTransaction(wallet, K.Refund, '10.00')).toThrow(ValidationError);
    expect(() => aTransaction(wallet, K.Rollback, '10.00')).toThrow(ValidationError);
    expect(() => aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' })).not.toThrow();
  });

  test('BET não pode ter referência; ninguém referencia a si mesmo', () => {
    expect(() => aTransaction(wallet, K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(ValidationError);
    expect(() =>
      aTransaction(wallet, K.Refund, '1.00', { externalTransactionId: 'a', referenceExternalTransactionId: 'a' }),
    ).toThrow(ValidationError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => aTransaction(wallet, K.Bet, '0.00')).toThrow(ValidationError);
    expect(() => aTransaction(wallet, K.Loss, '0.00')).not.toThrow();
  });

  test('estados terminais não mudam mais', () => {
    const tx = aTransaction(wallet, K.Bet, '10.00');
    tx.reject(FailureCode.InsufficientFunds, NOW, wallet.balance);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed(undefined, NOW, wallet.balance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(NOW, wallet.balance)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.ProcessingError, NOW)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE com backoff exponencial até esgotar', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 };
    const tx = aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    tx.markPendingReference(NOW, wallet.balance, policy);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(1000);

    tx.markPendingReference(NOW, wallet.balance, policy);
    expect(tx.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(2000);
    tx.markPendingReference(NOW, wallet.balance, policy);
    expect(tx.nextReferenceCheckAt!.getTime() - NOW.getTime()).toBe(3000); // teto
    tx.markPendingReference(NOW, wallet.balance, policy);
    expect(tx.referenceRetriesExhausted(policy)).toBe(true);

    tx.reject(FailureCode.ReferenceNotFound, NOW, wallet.balance);
    expect(tx.status).toBe(S.Rejected);
  });

  test('direção do ledger por kind; ROLLBACK inverte a referência', () => {
    const bet = aTransaction(wallet, K.Bet, '10.00');
    const win = aTransaction(wallet, K.Win, '10.00');
    const rollback = aTransaction(wallet, K.Rollback, '10.00', { referenceExternalTransactionId: 'r' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(aTransaction(wallet, K.Loss, '1.00').ledgerDirectionFor()).toBeUndefined();
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test('matchesPayload compara o hash', () => {
    const tx = aTransaction(wallet, K.Bet, '1.00', { payloadHash: 'a'.repeat(64) });
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});
