/**
 * End-to-end pipeline tests for SOMA portfolio analytics.
 *
 * Uses realistic Fed transaction data including BUY, MATURATION, and
 * MATURATION_OFFSET transactions to verify the full visualization pipeline.
 *
 * Note: Trade dates are on business days. Settlement occurs T+1 business day
 * after trade. Some transactions near month-end settle in the following month.
 */
import { describe, test, expect } from 'vitest';
import {
  adjustTransactionSigns,
  groupByMonthAndType,
  combineMaturationColumns,
  cumulativeSum,
  convertToBillions,
  computeSettlementDate,
  sortDates,
  calculateNetTotal,
  formatBillions,
  runPipeline,
} from '../src/pipeline.js';
import type { Transaction } from '../src/types.js';


/**
 * Realistic SOMA transaction dataset.
 *
 * Core mid-month activity (settle in same month):
 *   Jan: BUY 10B, MATURATION 3B, MATURATION_OFFSET 1B
 *   Feb: BUY 8B
 *   Mar: BUY 5B, MATURATION 6B
 *
 * Month-boundary settlements (settle in NEXT month):
 *   Jan 31 (Wed): MATURATION 4B, MATURATION_OFFSET 1.5B -> settle Feb 1
 *   Mar 29 (Fri): BUY 3B -> settle Apr 1 (Mon, skips weekend)
 *
 * Pure outflow month (settle in same month):
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
    // Month-boundary: Jan 31 (Wed) -> settle Feb 1 (Thu)
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
    // Month-boundary: Mar 29 (Fri) -> settle Apr 1 (Mon, skips weekend)
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
// Settlement date (Bug 4)
// =====================================================================
describe('settlement date – T+1 business day', () => {
  test('Monday trade settles Tuesday', () => {
    expect(computeSettlementDate('2024-01-15')).toBe('2024-01-16');
  });

  test('Wednesday trade settles Thursday (crosses month boundary)', () => {
    // Jan 31 (Wed) -> Feb 1 (Thu)
    expect(computeSettlementDate('2024-01-31')).toBe('2024-02-01');
  });

  test('Friday trade settles Monday (skips weekend)', () => {
    // Mar 29 (Fri) -> Apr 1 (Mon)
    expect(computeSettlementDate('2024-03-29')).toBe('2024-04-01');
  });

  test('Thursday trade settles Friday', () => {
    expect(computeSettlementDate('2024-02-01')).toBe('2024-02-02');
  });
});


// =====================================================================
// Combine maturation columns (Bug 1) + Settlement (Bug 4)
// =====================================================================
describe('combineMaturationColumns', () => {
  test('January MATURATION combines correctly (mid-month only)', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);

    // Jan mid-month: MATURATION=-3B + MATURATION_OFFSET=-1B = -4B
    // (Jan 31 transactions settle in Feb, not Jan)
    expect(combined['2024-01']['MATURATION']).toBe(-4_000_000_000);
    expect(combined['2024-01']['MATURATION_OFFSET']).toBeUndefined();
  });

  test('February combines Jan-31 settlement maturation correctly', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);

    // Feb: MATURATION=-4B (Jan 31 settle) + MATURATION_OFFSET=-1.5B (Jan 31) = -5.5B
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
// Cumulative sum with forward-fill (Bug 2)
// =====================================================================
describe('cumulativeSum – forward-fill', () => {
  test('MATURATION carries forward into April (no new maturations)', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);
    const combined = combineMaturationColumns(grouped);
    const dates = sortDates(Object.keys(combined));
    const cumulative = cumulativeSum(combined, dates);

    // Apr has only BUY (from Mar 29 settlement); cumulative MATURATION
    // should carry forward from March
    expect(cumulative['2024-04']).toBeDefined();
    expect(cumulative['2024-04']['MATURATION']).toBeDefined();
    expect(cumulative['2024-04']['MATURATION']).toBe(-15_500_000_000);
  });

  test('BUY carries forward into May (no new purchases)', () => {
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
// Settlement grouping (Bug 4 + Bug 1 interaction)
// =====================================================================
describe('settlement date – month boundary grouping', () => {
  test('Jan-31 maturation settles in February', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);

    // Jan 31 MATURATION + MATURATION_OFFSET settle Feb 1
    expect(grouped['2024-02']['MATURATION']).toBe(-4_000_000_000);
    expect(grouped['2024-02']['MATURATION_OFFSET']).toBe(-1_500_000_000);
  });

  test('Friday Mar-29 BUY settles Monday Apr-1', () => {
    const signed = adjustTransactionSigns(buildTestTransactions());
    const grouped = groupByMonthAndType(signed);

    // Mar 29 (Fri) BUY 3B settles Apr 1 (Mon)
    expect(grouped['2024-04']).toBeDefined();
    expect(grouped['2024-04']['BUY']).toBe(3_000_000_000);
  });
});


// =====================================================================
// Full pipeline end-to-end (all 4 bugs)
// =====================================================================
describe('full pipeline – end-to-end', () => {
  test('January net activity is +$6B (BUY 10B minus combined MATURATION 4B)', () => {
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
