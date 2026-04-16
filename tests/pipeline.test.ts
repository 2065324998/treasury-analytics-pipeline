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
 * Realistic SOMA transaction dataset covering Jan-May 2024.
 *
 * Core mid-month activity:
 *   Jan: BUY 10B, MATURATION 3B, MATURATION_OFFSET 1B
 *   Feb: BUY 8B
 *   Mar: BUY 5B, MATURATION 6B
 *
 * End-of-month activity:
 *   Jan 31: MATURATION 4B, MATURATION_OFFSET 1.5B
 *   Mar 29: BUY 3B
 *
 * Pure outflow:
 *   May: MATURATION 5B
 */
function buildTestTransactions(): Transaction[] {
  return [
    // January mid-month
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
      tradeDate: '2024-01-22',
      directedQuantity: 3_000_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '3M',
    },
    {
      identifier: '912797LX3',
      transactionType: 'MATURATION_OFFSET',
      tradeDate: '2024-01-22',
      directedQuantity: 1_000_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '3M',
    },
    // February mid-month
    {
      identifier: '91282CMC2',
      transactionType: 'BUY',
      tradeDate: '2024-02-01',
      directedQuantity: 8_000_000_000,
      price: 101.0,
      productType: 'Note',
      tenor: '5Y',
    },
    // March mid-month
    {
      identifier: '912810TW6',
      transactionType: 'BUY',
      tradeDate: '2024-03-11',
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
    // End-of-month: Jan 31 (Wednesday)
    {
      identifier: '912797CC1',
      transactionType: 'MATURATION',
      tradeDate: '2024-01-31',
      directedQuantity: 4_000_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '13W',
    },
    {
      identifier: '912797CC1',
      transactionType: 'MATURATION_OFFSET',
      tradeDate: '2024-01-31',
      directedQuantity: 1_500_000_000,
      price: 100,
      productType: 'Bill',
      tenor: '13W',
    },
    // End-of-month: Mar 29 (Friday)
    {
      identifier: '912810XX9',
      transactionType: 'BUY',
      tradeDate: '2024-03-29',
      directedQuantity: 3_000_000_000,
      price: 98.0,
      productType: 'Bond',
      tenor: '20Y',
    },
    // May: pure outflow month
    {
      identifier: '912797DD2',
      transactionType: 'MATURATION',
      tradeDate: '2024-05-01',
      directedQuantity: 5_000_000_000,
      price: 100,
      productType: 'Note',
      tenor: '1Y',
    },
  ];
}


// =====================================================================
// Combine maturation columns (Bug 1 + month attribution interaction)
// =====================================================================
describe('combineMaturationColumns', () => {
  test('January MATURATION combines correctly (mid-month transactions only)', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);

    // Only mid-month Jan transactions should be in January:
    // MATURATION -3B + MATURATION_OFFSET -1B = -4B
    expect(combined['2024-01']['MATURATION']).toBe(-4_000_000_000);
    expect(combined['2024-01']['MATURATION_OFFSET']).toBeUndefined();
  });

  test('February has combined maturation from end-of-January activity', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);

    // End-of-Jan maturation activity should appear in February:
    // MATURATION -4B + MATURATION_OFFSET -1.5B = -5.5B
    expect(combined['2024-02']['MATURATION']).toBe(-5_500_000_000);
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


// =====================================================================
// Month attribution for end-of-month transactions
// =====================================================================
describe('month attribution – end-of-month transactions', () => {
  test('Jan-31 maturation appears in February grouping', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);

    // The Jan-31 MATURATION and MATURATION_OFFSET should be attributed
    // to February, not January
    expect(grouped['2024-02']['MATURATION']).toBe(-4_000_000_000);
    expect(grouped['2024-02']['MATURATION_OFFSET']).toBe(-1_500_000_000);
  });

  test('Mar-29 BUY appears in April grouping', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);

    // The Mar-29 (Friday) BUY should be attributed to April
    expect(grouped['2024-04']).toBeDefined();
    expect(grouped['2024-04']['BUY']).toBe(3_000_000_000);
  });
});


// =====================================================================
// Cumulative sum with forward-fill (Bug 2)
// =====================================================================
describe('cumulativeSum – forward-fill', () => {
  test('MATURATION carries forward into April (no new maturations in April)', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);
    const dates = sortDates(Object.keys(combined));
    const cumulative = cumulativeSum(combined, dates);

    // April has only BUY; cumulative MATURATION should carry from March
    expect(cumulative['2024-04']).toBeDefined();
    expect(cumulative['2024-04']['MATURATION']).toBeDefined();
    expect(cumulative['2024-04']['MATURATION']).toBe(-15_500_000_000);
  });

  test('BUY carries forward into May (no new purchases in May)', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);
    const dates = sortDates(Object.keys(combined));
    const cumulative = cumulativeSum(combined, dates);

    // May has only MATURATION; cumulative BUY should carry from April
    expect(cumulative['2024-05']['BUY']).toBeDefined();
    expect(cumulative['2024-05']['BUY']).toBe(26_000_000_000);
  });
});


// =====================================================================
// Sign preservation in display (Bug 3)
// =====================================================================
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


// =====================================================================
// Full pipeline end-to-end
// =====================================================================
describe('full pipeline – end-to-end', () => {
  test('January net activity is +$6B (mid-month purchases minus maturations)', () => {
    const report = runPipeline(buildTestTransactions());
    const table = report.monthlyTable;

    const jan = table.find(r => r.month === '2024-01');
    expect(jan).toBeDefined();
    const janNet = parseFloat(jan!.net.replace(/[^0-9.-]/g, ''));
    expect(janNet).toBeCloseTo(6.0, 1);
  });

  test('May shows negative net activity (maturation only month)', () => {
    const report = runPipeline(buildTestTransactions());
    const table = report.monthlyTable;

    const may = table.find(r => r.month === '2024-05');
    expect(may).toBeDefined();
    expect(may!.net).toContain('-');
    const mayNet = parseFloat(may!.net.replace(/[^0-9.-]/g, ''));
    expect(mayNet).toBeCloseTo(-5.0, 1);
  });

  test('cumulative holdings decrease Mar vs Feb (maturations exceed purchases)', () => {
    const report = runPipeline(buildTestTransactions());
    const table = report.monthlyTable;

    const cumValues = table.map(r => {
      const val = r.cumulative.replace(/[^0-9.-]/g, '');
      return parseFloat(val);
    });
    const febIdx = table.findIndex(r => r.month === '2024-02');
    const marIdx = table.findIndex(r => r.month === '2024-03');
    expect(cumValues[marIdx]).toBeLessThan(cumValues[febIdx]);
  });

  test('activity chart has BUY and MATURATION traces, no MATURATION_OFFSET', () => {
    const report = runPipeline(buildTestTransactions());
    const traceNames = report.activityChart.traces.map(t => t.name);
    expect(traceNames).toContain('BUY');
    expect(traceNames).toContain('MATURATION');
    expect(traceNames).not.toContain('MATURATION_OFFSET');
  });

  test('activity chart MATURATION bars are negative (show outflows)', () => {
    const report = runPipeline(buildTestTransactions());
    const matTrace = report.activityChart.traces.find(t => t.name === 'MATURATION');
    expect(matTrace).toBeDefined();
    const nonZeroValues = matTrace!.y.filter(v => v !== 0);
    for (const val of nonZeroValues) {
      expect(val).toBeLessThan(0);
    }
  });
});
