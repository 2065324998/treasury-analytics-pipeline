/**
 * SOMA portfolio analytics pipeline.
 *
 * Processes Federal Reserve treasury transaction data through a series of
 * transformations to produce chart-ready visualization data:
 *
 *   raw transactions
 *     -> sign adjustment (BUY positive, outflows negative)
 *     -> group by month and transaction type
 *     -> combine maturation columns
 *     -> cumulative sum with forward-fill
 *     -> convert to display units (billions)
 *     -> generate Plotly traces
 */

import type { Transaction, ChartTrace, ChartLayout, DisplayReport, HoldingsSummary } from './types.js';

// ============================================================================
// Step 1: Sign adjustment
// ============================================================================

/**
 * Apply sign convention so quantities reflect portfolio impact.
 * BUY is positive (adds to portfolio).
 * SELL, MATURATION, and MATURATION_OFFSET are negative (reduce portfolio).
 *
 * The upstream position-service API always returns positive quantities
 * regardless of the transaction type.
 */
export function adjustTransactionSigns(transactions: Transaction[]): Transaction[] {
  return transactions.map(txn => {
    let qty = txn.directedQuantity;
    if (txn.transactionType === 'SELL' ||
        txn.transactionType === 'MATURATION' ||
        txn.transactionType === 'MATURATION_OFFSET') {
      qty = -Math.abs(qty);
    }
    return { ...txn, directedQuantity: qty };
  });
}

// ============================================================================
// Step 2: Group by month and transaction type
// ============================================================================

/**
 * Groups transactions by month (YYYY-MM) and transaction type, summing
 * directed quantities within each group.
 */
export function groupByMonthAndType(
  transactions: Transaction[]
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};

  for (const txn of transactions) {
    const month = txn.tradeDate.slice(0, 7); // YYYY-MM
    if (!result[month]) {
      result[month] = {};
    }
    const current = result[month][txn.transactionType] || 0;
    result[month][txn.transactionType] = current + txn.directedQuantity;
  }

  return result;
}

// ============================================================================
// Step 3: Combine maturation columns
// ============================================================================

/**
 * Combines MATURATION and MATURATION_OFFSET into a single MATURATION column.
 *
 * In the Fed's data, MATURATION_OFFSET represents the portion of a maturing
 * security that is NOT rolled over. It is an additional outflow beyond the
 * base MATURATION amount. Both are outflows (negative after sign adjustment).
 */
export function combineMaturationColumns(
  pivot: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const combined: Record<string, Record<string, number>> = {};

  for (const [date, values] of Object.entries(pivot)) {
    combined[date] = { ...values };

    if ('MATURATION_OFFSET' in combined[date]) {
      combined[date]['MATURATION'] =
        (combined[date]['MATURATION'] || 0) - combined[date]['MATURATION_OFFSET'];
      delete combined[date]['MATURATION_OFFSET'];
    }
  }

  return combined;
}

// ============================================================================
// Step 4: Cumulative sum with forward-fill
// ============================================================================

/**
 * Calculates cumulative sum for each category over time.
 *
 * Categories that appear in any period should be forward-filled in all
 * subsequent periods (carrying the running total forward even when no
 * new transactions occur in that period).
 */
export function cumulativeSum(
  pivot: Record<string, Record<string, number>>,
  sortedDates: string[]
): Record<string, Record<string, number>> {
  const cumulative: Record<string, Record<string, number>> = {};
  const runningTotals: Record<string, number> = {};

  for (const date of sortedDates) {
    cumulative[date] = {};
    const currentRow = pivot[date] || {};

    for (const category of Object.keys(currentRow)) {
      const increment = currentRow[category] ?? 0;
      runningTotals[category] = (runningTotals[category] || 0) + increment;
      cumulative[date][category] = runningTotals[category];
    }
  }

  return cumulative;
}

// ============================================================================
// Step 5: Convert to display units
// ============================================================================

/**
 * Converts values to billions (divides by 1e9).
 *
 * Treasury SOMA quantities are in dollars. For display purposes, we convert
 * to billions.
 */
export function convertToBillions(
  pivot: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const converted: Record<string, Record<string, number>> = {};

  for (const [date, values] of Object.entries(pivot)) {
    converted[date] = {};
    for (const [category, value] of Object.entries(values)) {
      converted[date][category] = Math.abs(value) / 1_000_000_000;
    }
  }

  return converted;
}

// ============================================================================
// Step 6: Generate chart traces
// ============================================================================

const CATEGORY_COLORS: Record<string, string> = {
  BUY: '#2ecc71',
  SELL: '#e74c3c',
  MATURATION: '#e67e22',
};

/**
 * Builds Plotly-compatible trace objects for a stacked bar chart.
 */
export function generateChartTraces(
  data: Record<string, Record<string, number>>,
  sortedDates: string[]
): ChartTrace[] {
  // Collect all categories
  const allCategories = new Set<string>();
  for (const row of Object.values(data)) {
    for (const cat of Object.keys(row)) {
      allCategories.add(cat);
    }
  }

  const traces: ChartTrace[] = [];
  for (const category of Array.from(allCategories).sort()) {
    const yValues = sortedDates.map(date => data[date]?.[category] ?? 0);
    traces.push({
      name: category,
      x: [...sortedDates],
      y: yValues,
      type: 'bar',
      stackgroup: 'activity',
      fillcolor: CATEGORY_COLORS[category] || '#95a5a6',
    });
  }

  return traces;
}

// ============================================================================
// Utility: sort dates
// ============================================================================

export function sortDates(dates: string[]): string[] {
  return [...dates].sort((a, b) => a.localeCompare(b));
}

// ============================================================================
// Utility: calculate net total per date
// ============================================================================

/**
 * Calculates the net total across all categories for each date.
 */
export function calculateNetTotal(
  pivot: Record<string, Record<string, number>>
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [date, values] of Object.entries(pivot)) {
    let total = 0;
    for (const value of Object.values(values)) {
      total += value;
    }
    totals[date] = total;
  }
  return totals;
}

// ============================================================================
// Utility: format currency for display
// ============================================================================

/**
 * Formats a number in billions with appropriate sign and precision.
 * e.g. 12.345 -> "$12.35B", -3.456 -> "-$3.46B"
 */
export function formatBillions(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toFixed(2)}B`;
}

// ============================================================================
// Full pipeline
// ============================================================================

/**
 * Runs the complete SOMA analytics pipeline from raw transactions to
 * display-ready report data.
 */
export function runPipeline(transactions: Transaction[]): DisplayReport {
  // Step 1: Sign adjustment
  const signed = adjustTransactionSigns(transactions);

  // Step 2: Group by month
  const grouped = groupByMonthAndType(signed);

  // Step 3: Combine maturation columns
  const combined = combineMaturationColumns(grouped);

  // Step 4: Get sorted dates and compute cumulative
  const dates = sortDates(Object.keys(combined));
  const cumulative = cumulativeSum(combined, dates);

  // Step 5: Convert to billions for display
  const activityBillions = convertToBillions(combined);
  const cumulativeBillions = convertToBillions(cumulative);

  // Step 6: Generate chart traces
  const activityTraces = generateChartTraces(activityBillions, dates);

  const holdingsTraces: ChartTrace[] = [];
  const cumulativeCategories = new Set<string>();
  for (const row of Object.values(cumulativeBillions)) {
    for (const cat of Object.keys(row)) {
      cumulativeCategories.add(cat);
    }
  }
  for (const category of Array.from(cumulativeCategories).sort()) {
    holdingsTraces.push({
      name: category,
      x: [...dates],
      y: dates.map(d => cumulativeBillions[d]?.[category] ?? 0),
      type: 'scatter',
      stackgroup: 'holdings',
      fillcolor: CATEGORY_COLORS[category] || '#95a5a6',
    });
  }

  // Compute net totals for the monthly table
  const netTotals = calculateNetTotal(combined);
  const netBillions = calculateNetTotal(activityBillions);
  const cumulativeNetTotals = calculateNetTotal(cumulative);
  const cumulativeNetBillions: Record<string, number> = {};
  for (const [date, val] of Object.entries(cumulativeNetTotals)) {
    cumulativeNetBillions[date] = val / 1_000_000_000;
  }

  const monthlyTable = dates.map(month => ({
    month,
    net: formatBillions(netBillions[month] || 0),
    cumulative: formatBillions(cumulativeNetBillions[month] || 0),
  }));

  // Holdings summary
  const lastDate = dates[dates.length - 1];
  const lastCumulative = cumulative[lastDate] || {};
  let totalMV = 0;
  for (const val of Object.values(lastCumulative)) {
    totalMV += val;
  }

  const summary: HoldingsSummary = {
    totalMarketValue: totalMV,
    totalParValue: totalMV, // simplified: assume par for this pipeline
    weightedAvgMaturity: 0,
    numPositions: Object.keys(lastCumulative).length,
    positionsByType: {},
  };

  return {
    activityChart: {
      traces: activityTraces,
      layout: {
        title: 'Monthly SOMA Activity',
        xaxis: { title: 'Month', tickangle: -45 },
        yaxis: { title: 'Amount ($B)', tickformat: ',.1f' },
        barmode: 'relative',
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: '#1a1a2e',
        font: { color: '#ffffff' },
      },
    },
    holdingsChart: {
      traces: holdingsTraces,
      layout: {
        title: 'Cumulative SOMA Holdings',
        xaxis: { title: 'Month', tickangle: -45 },
        yaxis: { title: 'Holdings ($B)', tickformat: ',.1f' },
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: '#1a1a2e',
        font: { color: '#ffffff' },
      },
    },
    summary,
    monthlyTable,
  };
}
