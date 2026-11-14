import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, ValidationError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com 2 casas', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('10.5').toString()).toBe('10.50');
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
  });

  test('aritmética exata (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('1.00').subtract(brl('1.01')).toString()).toBe('-0.01');
    expect(brl('999999999999999999.99').add(brl('0.01')).toString()).toBe('1000000000000000000.00');
  });

  test('é imutável: operações retornam nova instância', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(a.negate().toString()).toBe('-10.00');
  });

  test('comparações', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1').negate().isNegative()).toBe(true);
    expect(brl('79.99').isLessThan(brl('80'))).toBe(true);
    expect(brl('80.00').equals(brl('80'))).toBe(true);
    expect(brl('80.00').equals(Money.from({ amount: '80.00', currency: 'USD' }))).toBe(false);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['1e3'],
    [''],
    [' 1.00'],
    ['1.001'],
    ['10.005'], // não arredondamos: mais de 2 casas é rejeitado
    ['-1.00'],
    ['+1.00'],
    ['1,00'],
    ['01.00'],
    ['.50'],
    ['1.'],
    ['1234567890123456789.00'], // estoura numeric(20,2)
  ])('rejeita amount inválido %p', (amount) => {
    expect(() => brl(amount)).toThrow(ValidationError);
  });

  test('rejeita amount que não é string (number é proibido para dinheiro)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(ValidationError);
  });

  test.each([['brl'], ['BR'], ['REAL'], ['']])('rejeita moeda inválida %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(ValidationError);
  });

  test('operação entre moedas diferentes lança erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
