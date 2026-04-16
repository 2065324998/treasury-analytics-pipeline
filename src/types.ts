/**
 * Data types for SOMA (System Open Market Account) portfolio analytics.
 *
 * The Fed's SOMA portfolio holds US Treasury securities purchased through
 * open market operations. Transactions include:
 * - BUY: Security purchases (increase holdings)
 * - SELL: Security sales (decrease holdings)
 * - MATURATION: Security reaches maturity (decrease holdings)
 * - MATURATION_OFFSET: Adjustment to maturation amount for partial rollovers
 */

export interface Transaction {
  identifier: string;        // CUSIP
  transactionType: 'BUY' | 'SELL' | 'MATURATION' | 'MATURATION_OFFSET';
  tradeDate: string;         // YYYY-MM-DD
  maturityDate?: string;     // YYYY-MM-DD
  productType?: string;      // 'Bill', 'Note', 'Bond', 'TIPS', 'FRN'
  tenor?: string;            // e.g. '10Y', '3M', 'TERM: 5Y'
  directedQuantity: number;  // always positive from source; sign determined by type
  price: number;             // % of par, e.g. 99.5
  couponRate?: number;       // annual coupon in %, e.g. 4.5
}

export interface MonthlyActivity {
  month: string;             // YYYY-MM
  categories: Record<string, number>;  // transactionType -> sumQuantity
}

export interface HoldingsSummary {
  totalMarketValue: number;
  totalParValue: number;
  weightedAvgMaturity: number;  // in years
  numPositions: number;
  positionsByType: Record<string, number>;  // productType -> count
}

export interface ChartTrace {
  name: string;
  x: string[];
  y: number[];
  type: string;
  stackgroup?: string;
  line?: { color: string };
  fillcolor?: string;
}

export interface ChartLayout {
  title: string;
  xaxis: { title: string; tickangle?: number };
  yaxis: { title: string; tickformat?: string };
  barmode?: string;
  plot_bgcolor: string;
  paper_bgcolor: string;
  font: { color: string };
}

export interface DisplayReport {
  activityChart: { traces: ChartTrace[]; layout: ChartLayout };
  holdingsChart: { traces: ChartTrace[]; layout: ChartLayout };
  summary: HoldingsSummary;
  monthlyTable: { month: string; net: string; cumulative: string }[];
}
