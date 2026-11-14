import { describe, expect, test } from 'bun:test';
import { FailureCode as F } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind as K } from '../../src/domain/wager-transaction';
import { decideWager } from '../../src/domain/wager-rules';
import { LedgerDirection as D } from '../../src/domain/wallet-ledger-entry';
import { aTransaction, aWallet, processed } from '../support/builders';

const decide = (args: Parameters<typeof decideWager>[0]) => decideWager(args);

describe('Regras de negócio (decideWager)', () => {
  test('BET com saldo: débito', () => {
    const wallet = aWallet('100.00');
    const bet = aTransaction(wallet, K.Bet, '80.00');
    expect(decide({ wallet, transaction: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'apply',
      direction: D.Debit,
    });
  });

  test('BET sem saldo: INSUFFICIENT_FUNDS', () => {
    const wallet = aWallet('10.00');
    const bet = aTransaction(wallet, K.Bet, '10.01');
    expect(decide({ wallet, transaction: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.InsufficientFunds,
    });
  });

  test('WIN credita, com ou sem referência à BET', () => {
    const wallet = aWallet();
    const bet = processed(aTransaction(wallet, K.Bet, '10.00', { externalTransactionId: 'bet-1' }), wallet);
    const win = aTransaction(wallet, K.Win, '25.00', { referenceExternalTransactionId: 'bet-1' });
    expect(decide({ wallet, transaction: win, reference: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'apply',
      direction: D.Credit,
    });
    const freeWin = aTransaction(wallet, K.Win, '5.00');
    expect(decide({ wallet, transaction: freeWin, referenceAlreadyReversed: false }).type).toBe('apply');
  });

  test('LOSS não move saldo', () => {
    const wallet = aWallet();
    const loss = aTransaction(wallet, K.Loss, '10.00');
    expect(decide({ wallet, transaction: loss, referenceAlreadyReversed: false })).toEqual({ type: 'record' });
  });

  test('REFUND de BET processada credita; segunda vez é ALREADY_REVERSED', () => {
    const wallet = aWallet();
    const bet = processed(aTransaction(wallet, K.Bet, '10.00', { externalTransactionId: 'bet-1' }), wallet);
    const refund = aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(decide({ wallet, transaction: refund, reference: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'apply',
      direction: D.Credit,
    });
    expect(decide({ wallet, transaction: refund, reference: bet, referenceAlreadyReversed: true })).toEqual({
      type: 'reject',
      code: F.AlreadyReversed,
    });
  });

  test('REFUND só referencia BET', () => {
    const wallet = aWallet();
    const win = processed(aTransaction(wallet, K.Win, '10.00', { externalTransactionId: 'win-1' }), wallet);
    const refund = aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'win-1' });
    expect(decide({ wallet, transaction: refund, reference: win, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.InvalidReferenceKind,
    });
  });

  test('ROLLBACK de BET credita; ROLLBACK de WIN debita', () => {
    const wallet = aWallet('100.00');
    const bet = processed(aTransaction(wallet, K.Bet, '10.00', { externalTransactionId: 'bet-1' }), wallet);
    const win = processed(aTransaction(wallet, K.Win, '30.00', { externalTransactionId: 'win-1' }), wallet);
    const rbBet = aTransaction(wallet, K.Rollback, '10.00', { referenceExternalTransactionId: 'bet-1' });
    const rbWin = aTransaction(wallet, K.Rollback, '30.00', { referenceExternalTransactionId: 'win-1' });
    expect(decide({ wallet, transaction: rbBet, reference: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'apply',
      direction: D.Credit,
    });
    expect(decide({ wallet, transaction: rbWin, reference: win, referenceAlreadyReversed: false })).toEqual({
      type: 'apply',
      direction: D.Debit,
    });
  });

  test('ROLLBACK que deixaria saldo negativo: REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', () => {
    const wallet = aWallet('5.00');
    const win = processed(aTransaction(wallet, K.Win, '30.00', { externalTransactionId: 'win-1' }), wallet);
    const rb = aTransaction(wallet, K.Rollback, '30.00', { referenceExternalTransactionId: 'win-1' });
    expect(decide({ wallet, transaction: rb, reference: win, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.ReversalInsufficientFunds,
    });
  });

  test('ROLLBACK não referencia LOSS', () => {
    const wallet = aWallet();
    const loss = processed(aTransaction(wallet, K.Loss, '10.00', { externalTransactionId: 'loss-1' }), wallet);
    const rb = aTransaction(wallet, K.Rollback, '10.00', { referenceExternalTransactionId: 'loss-1' });
    expect(decide({ wallet, transaction: rb, reference: loss, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.InvalidReferenceKind,
    });
  });

  test('reversão precisa ter o mesmo valor', () => {
    const wallet = aWallet();
    const bet = processed(aTransaction(wallet, K.Bet, '10.00', { externalTransactionId: 'bet-1' }), wallet);
    const refund = aTransaction(wallet, K.Refund, '9.99', { referenceExternalTransactionId: 'bet-1' });
    expect(decide({ wallet, transaction: refund, reference: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.AmountMismatch,
    });
  });

  test('referência ausente: espera (PENDING_REFERENCE)', () => {
    const wallet = aWallet();
    const refund = aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'not-yet' });
    expect(decide({ wallet, transaction: refund, referenceAlreadyReversed: false })).toEqual({
      type: 'wait-reference',
    });
  });

  test('referência de outra rodada/wallet: REFERENCE_MISMATCH', () => {
    const wallet = aWallet();
    const bet = processed(
      aTransaction(wallet, K.Bet, '10.00', { externalTransactionId: 'bet-1', roundId: 'other-round' }),
      wallet,
    );
    const refund = aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(decide({ wallet, transaction: refund, reference: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.ReferenceMismatch,
    });
  });

  test('referência REJECTED: REFERENCE_NOT_PROCESSED', () => {
    const wallet = aWallet();
    const bet = aTransaction(wallet, K.Bet, '10.00', { externalTransactionId: 'bet-1' });
    bet.reject(F.InsufficientFunds, new Date(), wallet.balance);
    const refund = aTransaction(wallet, K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(decide({ wallet, transaction: refund, reference: bet, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.ReferenceNotProcessed,
    });
  });

  test('conflito de moeda e de jogador', () => {
    const wallet = aWallet();
    const usdBet = aTransaction(wallet, K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) });
    expect(decide({ wallet, transaction: usdBet, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.CurrencyMismatch,
    });
    const otherPlayer = aTransaction(wallet, K.Bet, '1.00', { playerId: 'someone-else' });
    expect(decide({ wallet, transaction: otherPlayer, referenceAlreadyReversed: false })).toEqual({
      type: 'reject',
      code: F.PlayerMismatch,
    });
  });
});
