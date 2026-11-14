import { CurrencyMismatchError, ValidationError } from './errors';

/** Formato usado nos contratos (HTTP, SQS, eventos). */
export interface MoneyProps {
  amount: string; // decimal string com 2 casas, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

// Apenas dígitos, ponto opcional e no máximo 2 casas. Isso já rejeita:
// NaN, Infinity, notação científica (1e3), string vazia, sinal negativo,
// espaços e mais de 2 casas decimais. Limite de 18 dígitos inteiros = numeric(20,2).
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável.
 *
 * Internamente guardamos CENTAVOS em um `bigint` (inteiro de precisão
 * arbitrária). Assim nunca existe erro de arredondamento de ponto flutuante:
 * 0.10 + 0.20 é exatamente 0.30. A escala é fixa em 2 casas.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Cria a partir do contrato externo. Rejeita qualquer entrada ambígua. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new ValidationError('money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new ValidationError(
        'money.amount must be a non-negative decimal string with at most 2 decimal places',
      );
    }
    Money.assertCurrency(currency);
    const [integerPart, fractionPart = ''] = amount.split('.');
    const cents = BigInt(integerPart!) * 100n + BigInt(fractionPart.padEnd(2, '0'));
    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre 2 casas: 1050n -> "10.50"; -5n -> "-0.05". */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const integerPart = abs / 100n;
    const fractionPart = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new ValidationError('money.currency must be an ISO-4217 code (e.g. BRL)');
    }
  }
}
