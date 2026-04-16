/**
 * Basic unit tests for individual pipeline functions.
 * These tests pass with the current code and should continue to pass
 * after any bug fixes.
 */
import { describe, test, expect } from 'vitest';
import {
  adjustTransactionSigns,
  groupByMonthAndType,
  sortDates,
  calculateNetTotal,
  formatBillions,
  generateChartTraces,
} from '../src/pipeline.js';
import type { Transaction } from '../src/types.js';

function makeTxn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    identifier: '912828Z27',
    transactionType: 'BUY',
    tradeDate: '2024-01-15',
    directedQuantity: 1_000_000_000,
    price: 100,
    ...overrides,
  };
}

describe('adjustTransactionSigns', () => {
  test('BUY remains positive', () => {
    const result = adjustTransactionSigns([makeTxn({ transactionType: 'BUY' })]);
    expect(result[0].directedQuantity).toBe(1_000_000_000);
  });

  test('SELL becomes negative', () => {
    const result = adjustTransactionSigns([makeTxn({ transactionType: 'SELL' })]);
    expect(result[0].directedQuantity).toBe(-1_000_000_000);
  });

  test('MATURATION becomes negative', () => {
    const result = adjustTransactionSigns([makeTxn({ transactionType: 'MATURATION' })]);
    expect(result[0].directedQuantity).toBe(-1_000_000_000);
  });

  test('MATURATION_OFFSET becomes negative', () => {
    const result = adjustTransactionSigns([makeTxn({ transactionType: 'MATURATION_OFFSET' })]);
    expect(result[0].directedQuantity).toBe(-1_000_000_000);
  });
});

describe('groupByMonthAndType', () => {
  test('groups by month', () => {
    const txns = [
      makeTxn({ tradeDate: '2024-01-15', directedQuantity: 5 }),
      makeTxn({ tradeDate: '2024-01-20', directedQuantity: 3 }),
      makeTxn({ tradeDate: '2024-02-10', directedQuantity: 7 }),
    ];
    const result = groupByMonthAndType(txns);
    expect(result['2024-01']['BUY']).toBe(8);
    expect(result['2024-02']['BUY']).toBe(7);
  });

  test('groups by transaction type within month', () => {
    const txns = [
      makeTxn({ tradeDate: '2024-03-01', transactionType: 'BUY', directedQuantity: 10 }),
      makeTxn({ tradeDate: '2024-03-15', transactionType: 'MATURATION', directedQuantity: -4 }),
    ];
    const result = groupByMonthAndType(txns);
    expect(result['2024-03']['BUY']).toBe(10);
    expect(result['2024-03']['MATURATION']).toBe(-4);
  });
});

describe('sortDates', () => {
  test('sorts YYYY-MM strings ascending', () => {
    const result = sortDates(['2024-03', '2024-01', '2024-02']);
    expect(result).toEqual(['2024-01', '2024-02', '2024-03']);
  });

  test('handles empty array', () => {
    expect(sortDates([])).toEqual([]);
  });
});

describe('calculateNetTotal', () => {
  test('sums all categories per date', () => {
    const pivot = {
      '2024-01': { BUY: 10, MATURATION: -3 },
      '2024-02': { BUY: 8 },
    };
    const result = calculateNetTotal(pivot);
    expect(result['2024-01']).toBe(7);
    expect(result['2024-02']).toBe(8);
  });
});

describe('formatBillions', () => {
  test('formats positive value', () => {
    expect(formatBillions(12.345)).toBe('$12.35B');
  });

  test('formats negative value', () => {
    expect(formatBillions(-3.456)).toBe('-$3.46B');
  });

  test('formats zero', () => {
    expect(formatBillions(0)).toBe('$0.00B');
  });
});

describe('generateChartTraces', () => {
  test('creates one trace per category', () => {
    const data = {
      '2024-01': { BUY: 10, MATURATION: -3 },
      '2024-02': { BUY: 8, MATURATION: -2 },
    };
    const dates = ['2024-01', '2024-02'];
    const traces = generateChartTraces(data, dates);
    expect(traces.length).toBe(2);
    expect(traces.map(t => t.name).sort()).toEqual(['BUY', 'MATURATION']);
  });

  test('fills missing category with zero', () => {
    const data = {
      '2024-01': { BUY: 10 },
      '2024-02': { BUY: 8, MATURATION: -2 },
    };
    const dates = ['2024-01', '2024-02'];
    const traces = generateChartTraces(data, dates);
    const matTrace = traces.find(t => t.name === 'MATURATION')!;
    expect(matTrace.y[0]).toBe(0);  // missing from 2024-01
    expect(matTrace.y[1]).toBe(-2);
  });
});
