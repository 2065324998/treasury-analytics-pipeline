/**
 * End-to-end pipeline tests for SOMA portfolio analytics.
 *
 * Uses realistic Fed transaction data including BUY, MATURATION, and
 * MATURATION_OFFSET transactions to verify the full visualization pipeline.
 */
import { describe, test, expect } from 'vitest';
import {
  adjustTransactionSigns,
  groupByMonthAndType,
  combineMaturationColumns,
  cumulativeSum,
  convertToBillions,
  sortDates,
  calculateNetTotal,
  formatBillions,
  runPipeline,
} from '../src/pipeline.js';
import type { Transaction } from '../src/types.js';


/**
 * Realistic SOMA transaction dataset.
 *
 * Jan 2024: BUY 10B, MATURATION -3B, MATURATION_OFFSET -1B
 * Feb 2024: BUY 8B (no maturations)
 * Mar 2024: BUY 5B, MATURATION -6B
 * Apr 2024: MATURATION -2B (no purchases -- net portfolio reduction)
 */
function buildTestTransactions(): Transaction[] {
  return [
    // January
    {
      identifier: '912828Z27',
      transactionType: 'BUY',
      tradeDate: '2024-01-15',
      directedQuantity: 10_000_000_000,
      price: 99.5,
      productType: 'Note',
      tenor: '10Y',
    },
    {
      identifier: '912797LX3',
      transactionType: 'MATURATION',
      tradeDate: '2024-01-20',
      directedQuantity: 3_000_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '3M',
    },
    {
      identifier: '912797LX3',
      transactionType: 'MATURATION_OFFSET',
      tradeDate: '2024-01-20',
      directedQuantity: 1_000_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '3M',
    },
    // February
    {
      identifier: '91282CMC2',
      transactionType: 'BUY',
      tradeDate: '2024-02-01',
      directedQuantity: 8_000_000_000,
      price: 101.0,
      productType: 'Note',
      tenor: '5Y',
    },
    // March
    {
      identifier: '912810TW6',
      transactionType: 'BUY',
      tradeDate: '2024-03-10',
      directedQuantity: 5_000_000_000,
      price: 95.0,
      productType: 'Bond',
      tenor: '30Y',
    },
    {
      identifier: '912828XX1',
      transactionType: 'MATURATION',
      tradeDate: '2024-03-15',
      directedQuantity: 6_000_000_000,
      price: 100,
      productType: 'Note',
      tenor: '2Y',
    },
    // April -- only maturations
    {
      identifier: '912797AB2',
      transactionType: 'MATURATION',
      tradeDate: '2024-04-01',
      directedQuantity: 2_000_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '6M',
    },
  ];
}


describe('combineMaturationColumns', () => {
  test('MATURATION_OFFSET is added to MATURATION (both are outflows)', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);

    // Jan: MATURATION = -3B, MATURATION_OFFSET = -1B
    // Combined MATURATION should be -3B + (-1B) = -4B
    expect(combined['2024-01']['MATURATION']).toBe(-4_000_000_000);
    expect(combined['2024-01']['MATURATION_OFFSET']).toBeUndefined();
  });

  test('MATURATION_OFFSET key is removed after combination', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);

    for (const values of Object.values(combined)) {
      expect('MATURATION_OFFSET' in values).toBe(false);
    }
  });
});


describe('cumulativeSum – forward-fill', () => {
  test('categories carry forward when absent from a period', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);
    const dates = sortDates(Object.keys(combined));
    const cumulative = cumulativeSum(combined, dates);

    // Feb has only BUY; cumulative MATURATION should carry forward from Jan
    expect(cumulative['2024-02']['MATURATION']).toBeDefined();
    expect(cumulative['2024-02']['MATURATION']).toBe(-4_000_000_000);
  });

  test('forward-fill preserves running total through gaps', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);
    const dates = sortDates(Object.keys(combined));
    const cumulative = cumulativeSum(combined, dates);

    // BUY cumulative: Jan=10B, Feb=18B, Mar=23B, Apr=23B (no new buys)
    expect(cumulative['2024-01']['BUY']).toBe(10_000_000_000);
    expect(cumulative['2024-02']['BUY']).toBe(18_000_000_000);
    expect(cumulative['2024-03']['BUY']).toBe(23_000_000_000);
    expect(cumulative['2024-04']['BUY']).toBe(23_000_000_000);

    // MATURATION cumulative: Jan=-4B, Feb=-4B (carry), Mar=-10B, Apr=-12B
    expect(cumulative['2024-01']['MATURATION']).toBe(-4_000_000_000);
    expect(cumulative['2024-02']['MATURATION']).toBe(-4_000_000_000);
    expect(cumulative['2024-03']['MATURATION']).toBe(-10_000_000_000);
    expect(cumulative['2024-04']['MATURATION']).toBe(-12_000_000_000);
  });
});


describe('convertToBillions – sign preservation', () => {
  test('negative values remain negative after conversion', () => {
    const data = {
      '2024-01': { BUY: 10_000_000_000, MATURATION: -4_000_000_000 },
    };
    const result = convertToBillions(data);
    expect(result['2024-01']['BUY']).toBeCloseTo(10.0, 2);
    expect(result['2024-01']['MATURATION']).toBeCloseTo(-4.0, 2);
  });

  test('MATURATION outflows display as negative in billions', () => {
    const data = {
      '2024-03': { BUY: 5_000_000_000, MATURATION: -6_000_000_000 },
    };
    const result = convertToBillions(data);
    expect(result['2024-03']['MATURATION']).toBeLessThan(0);
  });
});


describe('full pipeline – end-to-end', () => {
  test('monthly net activity reflects purchases minus maturations', () => {
    const report = runPipeline(buildTestTransactions());
    const table = report.monthlyTable;

    // Jan: BUY 10B, combined MATURATION -4B -> net = +6B
    const jan = table.find(r => r.month === '2024-01');
    expect(jan).toBeDefined();
    // net should be positive (more buys than maturations)
    expect(jan!.net).toContain('$');
    // Parse the dollar value
    const janNet = parseFloat(jan!.net.replace(/[^0-9.-]/g, ''));
    expect(janNet).toBeCloseTo(6.0, 1);
  });

  test('April shows negative net activity (maturation only)', () => {
    const report = runPipeline(buildTestTransactions());
    const table = report.monthlyTable;

    // Apr: only MATURATION -2B -> net should be negative
    const apr = table.find(r => r.month === '2024-04');
    expect(apr).toBeDefined();
    expect(apr!.net).toContain('-');
    const aprNet = parseFloat(apr!.net.replace(/[^0-9.-]/g, ''));
    expect(aprNet).toBeCloseTo(-2.0, 1);
  });

  test('cumulative holdings decrease when maturations exceed purchases', () => {
    const report = runPipeline(buildTestTransactions());
    const table = report.monthlyTable;

    // Cumulative net: Jan=6, Feb=14, Mar=13, Apr=11
    const cumValues = table.map(r => {
      const val = r.cumulative.replace(/[^0-9.-]/g, '');
      return parseFloat(val);
    });
    // Mar cumulative < Feb cumulative (maturations exceeded purchases in March)
    const febIdx = table.findIndex(r => r.month === '2024-02');
    const marIdx = table.findIndex(r => r.month === '2024-03');
    expect(cumValues[marIdx]).toBeLessThan(cumValues[febIdx]);
  });

  test('activity chart has correct number of traces', () => {
    const report = runPipeline(buildTestTransactions());
    // Should have BUY and MATURATION traces (MATURATION_OFFSET is combined)
    const traceNames = report.activityChart.traces.map(t => t.name);
    expect(traceNames).toContain('BUY');
    expect(traceNames).toContain('MATURATION');
    expect(traceNames).not.toContain('MATURATION_OFFSET');
  });

  test('activity chart MATURATION bars are negative (show outflows)', () => {
    const report = runPipeline(buildTestTransactions());
    const matTrace = report.activityChart.traces.find(t => t.name === 'MATURATION');
    expect(matTrace).toBeDefined();
    // All MATURATION values should be negative (outflows from portfolio)
    const nonZeroValues = matTrace!.y.filter(v => v !== 0);
    for (const val of nonZeroValues) {
      expect(val).toBeLessThan(0);
    }
  });
});
