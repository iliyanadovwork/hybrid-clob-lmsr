/**
 * Unified Engine Interface and Common Types
 *
 * Provides a standard interface that both CLOB and LMSR engines implement,
 * enabling apples-to-apples comparison via the simulation runner.
 */

import { Decimal } from "decimal.js";

// ============================================================================
// Common Types
// ============================================================================

export type Outcome = "YES" | "NO";
export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

/**
 * Standard Order Intent - uniform input format for all engines
 */
export interface OrderIntent {
  /** Unique identifier for this order intent */
  intentId: string;
  /** Trader placing the order */
  traderId: string;
  /** Which outcome to trade (YES/NO) - for prediction markets */
  outcome: Outcome;
  /** Buy (long) or Sell (short) */
  side: Side;
  /** Order type */
  orderType: OrderType;
  /** Limit price (required for LIMIT orders) */
  price?: number | Decimal;
  /** Quantity to trade (alternative to spend) */
  qty?: number | Decimal;
  /** Amount to spend (alternative to qty) */
  spend?: number | Decimal;
  /** When the order was submitted */
  timestamp: number;
}

/**
 * Information about a single fill/trade
 */
export interface FillInfo {
  /** Fill ID */
  fillId: string;
  /** Order intent ID */
  intentId: string;
  /** Trader ID */
  traderId: string;
  /** Side */
  side: Side;
  /** Outcome */
  outcome: Outcome;
  /** Price at which this fill occurred */
  price: Decimal;
  /** Quantity filled */
  qty: Decimal;
  /** USD value of this fill */
  value: Decimal;
  /** Counterparty (if applicable) */
  counterparty?: string;
  /** Timestamp of fill */
  timestamp: number;
}

/**
 * Market state snapshot for analysis
 */
export interface MarketStateSnapshot {
  /** Snapshot timestamp */
  timestamp: number;
  /** Engine type that generated this snapshot */
  engineType: string;
  /** Current mid price (if available) */
  midPrice?: Decimal;
  /** Best bid price (CLOB) */
  bestBid?: Decimal;
  /** Best ask price (CLOB) */
  bestAsk?: Decimal;
  /** Current spread (CLOB) */
  spread?: Decimal;
  /** Current YES price (LMSR) */
  priceYes?: Decimal;
  /** Current NO price (LMSR) */
  priceNo?: Decimal;
  /** Available depth at best bid (CLOB) */
  bidDepth?: Decimal;
  /** Available depth at best ask (CLOB) */
  askDepth?: Decimal;
  /** Outstanding YES shares (LMSR) */
  qYes?: Decimal;
  /** Outstanding NO shares (LMSR) */
  qNo?: Decimal;
  /** Total volume traded so far */
  totalVolume?: Decimal;
  /** Total value traded so far */
  totalValue?: Decimal;
}

/**
 * Engine state deltas - what changed from processing an order
 */
export interface EngineStateDeltas {
  /** How much each trader's cash changed */
  cashChanges: Map<string, Decimal>;
  /** How much each trader's YES shares changed */
  yesShareChanges: Map<string, Decimal>;
  /** How much each trader's NO shares changed */
  noShareChanges: Map<string, Decimal>;
  /** Orders that were added */
  ordersAdded: string[];
  /** Orders that were removed/filled */
  ordersRemoved: string[];
  /** Orders that were modified (partial fill) */
  ordersModified: string[];
}

/**
 * Standard Execution Result - uniform output format for all engines
 */
export interface ExecutionResult {
  /** Engine that processed this order */
  engineType: string;
  /** Order intent that was processed */
  intent: OrderIntent;
  /** Status of the order */
  status: "FILLED" | "PARTIALLY_FILLED" | "REJECTED" | "CANCELLED" | "OPEN";
  /** Individual fills/trades */
  fills: FillInfo[];
  /** Total quantity filled */
  filledQty: Decimal;
  /** Total quantity remaining/unfilled */
  remainingQty: Decimal;
  /** Average fill price (weighted by qty) */
  avgFillPrice: Decimal;
  /** Reference price at submission time */
  priceBefore: Decimal | null;
  /** Reference price after execution */
  priceAfter: Decimal | null;
  /** Slippage (priceBefore vs avgFillPrice) */
  slippage: Decimal | null;
  /** Price impact (priceAfter - priceBefore) */
  priceImpact: Decimal | null;
  /** State deltas */
  deltas: EngineStateDeltas;
  /** Updated market state snapshot */
  marketState: MarketStateSnapshot;
  /** Log entries from this execution */
  logs: LogEntry[];
  /** Timestamp when processing completed */
  timestamp: number;
}

/**
 * Standard Log Entry types
 */
export type LogEntryType =
  | "ORDER_RECEIVED"
  | "ORDER_ACCEPTED"
  | "ORDER_PLACED"
  | "ORDER_REJECTED"
  | "ORDER_FILLED"
  | "ORDER_PARTIALLY_FILLED"
  | "ORDER_CANCELLED"
  | "TRADE_EXECUTED"
  | "MARKET_STATE_UPDATE"
  | "ROUTING_DECISION"
  | "ERROR";

export interface LogEntry {
  type: LogEntryType;
  timestamp: number;
  engineType: string;
  data: unknown;
}

/**
 * Engine configuration interface
 */
export interface EngineConfig {
  /** Engine type identifier */
  type: string;
  /** Liquidity parameter (b for LMSR, etc.) */
  liquidity?: number;
  /** Tick size for CLOB */
  tickSize?: number;
  /** Minimum order size */
  minOrderSize?: number;
  /** Maximum order size */
  maxOrderSize?: number;
}

/**
 * Trader state for export
 */
export interface TraderState {
  traderId: string;
  cash: Decimal;
  yesShares: Decimal;
  noShares: Decimal;
  openOrders: number;
  totalTrades: number;
  totalVolume: Decimal;
  totalValue: Decimal;
}

// ============================================================================
// Engine Interface
// ============================================================================

/**
 * Unified Engine Interface
 *
 * Both CLOB and LMSR engines implement this interface,
 * enabling apples-to-apples comparison.
 */
export interface UnifiedEngine {
  /** Engine type identifier */
  readonly engineType: string;

  /** Engine configuration */
  readonly config: EngineConfig;

  /**
   * Initialize the engine state
   */
  initialize(): void;

  /**
   * Process an order intent
   * @returns Execution result with fills, state changes, etc.
   */
  processOrder(intent: OrderIntent): ExecutionResult;

  /**
   * Add a trader with initial cash
   */
  addTrader(traderId: string, cash: number): void;

  /**
   * Credit shares to a trader (for seeding initial positions)
   * Only used for CLOB to allow early sell orders
   */
  creditShares(traderId: string, outcome: Outcome, qty: number): void;

  /**
   * Get current market state snapshot
   */
  getMarketState(): MarketStateSnapshot;

  /**
   * Get trader state
   */
  getTraderState(traderId: string): TraderState | null;

  /**
   * Get all trader states
   */
  getAllTraderStates(): Map<string, TraderState>;

  /**
   * Reset engine to initial state
   */
  reset(): void;

  /**
   * Get current mid price (if available)
   */
  getMidPrice(): Decimal | null;

  /**
   * Get best bid (buy side) - for CLOB
   */
  getBestBid(): Decimal | null;

  /**
   * Get best ask (sell side) - for CLOB
   */
  getBestAsk(): Decimal | null;

  /**
   * Get current spread (if applicable)
   */
  getSpread(): Decimal | null;

  /**
   * Get depth at top N price levels - for CLOB
   */
  getDepth(side: Side, ticks: number): Decimal;

  /**
   * Cancel an open order
   */
  cancelOrder(orderId: string): ExecutionResult | null;

  /**
   * Get all log entries
   */
  getLogs(): readonly LogEntry[];

  /**
   * Clear logs
   */
  clearLogs(): void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate mid price from two sides
 */
export function calcMidPrice(bid: Decimal | null, ask: Decimal | null): Decimal | null {
  if (!bid || !ask) return null;
  return bid.plus(ask).div(2);
}

/**
 * Calculate spread from two sides
 */
export function calcSpread(bid: Decimal | null, ask: Decimal | null): Decimal | null {
  if (!bid || !ask) return null;
  return ask.minus(bid);
}

/**
 * Calculate slippage
 * @param referencePrice - Expected/mid price at submission
 * @param executionPrice - Average price actually received
 * @param side - BUY or SELL (affects slippage sign)
 */
export function calcSlippage(
  referencePrice: Decimal,
  executionPrice: Decimal,
  side: Side
): Decimal {
  if (side === "BUY") {
    // Buyers want lower prices; positive slippage = worse
    return executionPrice.minus(referencePrice);
  } else {
    // Sellers want higher prices; negative slippage = worse
    return referencePrice.minus(executionPrice);
  }
}

/**
 * Calculate price impact
 * @param priceBefore - Mid price before trade
 * @param priceAfter - Mid price after trade
 * @param side - BUY or SELL
 */
export function calcPriceImpact(
  priceBefore: Decimal,
  priceAfter: Decimal,
  side: Side
): Decimal {
  const impact = priceAfter.minus(priceBefore);
  // Buying pushes price up (positive impact), selling pushes down (negative)
  return side === "BUY" ? impact : impact.negated();
}
