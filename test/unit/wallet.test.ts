import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { aWallet, brl, NOW } from '../support/builders';

describe('Wallet', () => {
  test('abre com version 1 e saldo inicial; lançamento de abertura 0 -> saldo', () => {
    const wallet = aWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    const entry = wallet.openingEntry(randomUUID());
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('1000.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('debit devolve o lançamento e incrementa version', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit(brl('80.00'), randomUUID(), NOW);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
  });

  test('saldo nunca fica negativo', () => {
    const wallet = aWallet('100.00');
    wallet.debit(brl('80.00'), randomUUID(), NOW);
    expect(() => wallet.debit(brl('80.00'), randomUUID(), NOW)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2); // não mudou
  });

  test('pode debitar exatamente o saldo inteiro', () => {
    const wallet = aWallet('50.00');
    wallet.debit(brl('50.00'), randomUUID(), NOW);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('credit soma e incrementa version', () => {
    const wallet = aWallet('10.00');
    wallet.credit(brl('0.50'), randomUUID(), NOW);
    expect(wallet.balance.toString()).toBe('10.50');
    expect(wallet.version).toBe(2);
  });

  test('moeda da operação deve ser a moeda da wallet', () => {
    const wallet = aWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, randomUUID(), NOW)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, randomUUID(), NOW)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('ledger: create rejeita aritmética que não fecha', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: randomUUID(),
        transactionId: randomUUID(),
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
        createdAt: NOW,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});
