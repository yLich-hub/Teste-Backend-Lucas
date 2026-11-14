import { randomUUID } from 'node:crypto';
import { CurrencyMismatchError, InsufficientFundsError, ValidationError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. É a unidade de concorrência: toda alteração de saldo
 * acontece com a linha da wallet travada no banco (SELECT ... FOR UPDATE).
 *
 * Invariantes:
 * - saldo nunca negativo;
 * - toda alteração de saldo devolve o lançamento de ledger correspondente
 *   (debit/credit são a ÚNICA forma de mudar o saldo);
 * - version começa em 1 e só incrementa quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma wallet. O saldo inicial já entra aqui e a version começa em 1.
   * O lançamento OPENING correspondente é criado por `openingEntry`.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError('initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lançamento de crédito do saldo de abertura (0 -> saldo inicial). */
  openingEntry(transactionId: string): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: this.createdAt,
    });
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  /** Atalho usado pelo processador: escolhe debit/credit pela direção. */
  move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return direction === LedgerDirection.Debit
      ? this.debit(money, transactionId, at)
      : this.credit(money, transactionId, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
    // `create` valida a aritmética e a positividade do valor ANTES de mudarmos o estado.
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
