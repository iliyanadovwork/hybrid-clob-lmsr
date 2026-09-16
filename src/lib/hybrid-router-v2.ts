/**
 * Hybrid Router v2 - Improved Position Management
 *
 * Routes orders between CLOB and LMSR with shared position tracking:
 * - Maintains single source of truth for trader positions
 * - Tries CLOB first, falls back to LMSR for unfilled quantity
 * - Both buys and sells can use either engine (LMSR sells use the native
 *   share-returning primitive, capped at the trader's outstanding balance)
 *
 * This solves the "split positions" problem of v1 where traders could have
 * positions in both engines that couldn't be transferred.
 */

import { Decimal } from "decimal.js";
import {
  UnifiedEngine,
  OrderIntent,
  ExecutionResult,
  MarketStateSnapshot,
  Side,
  Outcome,
  EngineConfig,
  LogEntry,
  calcMidPrice,
  calcSlippage,
  calcPriceImpact,
} from "./engine-common";
import { CLOBEngine, CLOBLedger, TraderAccount as CLOBTraderAccount } from "./clob";
import { BinaryLMSR, Ledger as LMSRLedger, TraderAccount as LMSRTraderAccount } from "./binaryLmsr";

// ============================================================================
// Types
// ============================================================================

/**
 * Routing decision for a single order execution
 */
export interface RoutingDecision {
  /** Engine used for this execution */
  engine: "CLOB" | "LMSR";
  /** Quantity executed by this engine */
  qty: Decimal;
  /** Price obtained */
  price: Decimal;
  /** Reason for routing choice */
  reason: string;
  /** Status from the engine (OPEN, PARTIALLY_FILLED, FILLED, REJECTED, CANCELLED) */
  engineStatus?: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED";
}

/**
 * Combined routing result (may span both engines)
 */
export interface HybridRoutingResult {
  /** All routing decisions made */
  decisions: RoutingDecision[];
  /** Total quantity filled */
  totalFilledQty: Decimal;
  /** Total quantity remaining unfilled */
  totalRemainingQty: Decimal;
  /** Average fill price across all engines */
  avgFillPrice: Decimal;
  /** Final status of the order */
  finalStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED";
}

/**
 * Shared trader position (single source of truth)
 */
export interface SharedTraderPosition {
  traderId: string;
  cash: Decimal;
  yesShares: Decimal;
  noShares: Decimal;
  /** Orders placed on CLOB */
  clobOpenOrders: Set<string>;
  /** Timestamp of last update */
  lastUpdate: number;
}

/**
 * Hybrid engine configuration
 */
export interface HybridConfigV2 extends EngineConfig {
  type: "HYBRID_V2";
  /** CLOB engine config */
  clobConfig?: {
    tickSize?: number;
  };
  /** LMSR engine config */
  lmsrConfig?: {
    b?: number;
  };
  /** Maximum spread to use CLOB */
  maxSpread?: number;
  /** Minimum depth to use CLOB */
  minDepth?: number;
  /** Number of ticks to check for depth */
  depthTicks?: number;
}

// ============================================================================
// Hybrid Router V2
// ============================================================================

export class HybridRouterV2 implements UnifiedEngine {
  readonly engineType = "HYBRID_V2";
  readonly config: HybridConfigV2;

  private clobEngine: CLOBEngine;
  private clobLedger: CLOBLedger;
  private lmsrEngine: BinaryLMSR;
  private lmsrLedger: LMSRLedger;

  /** Single source of truth for positions */
  private sharedPositions: Map<string, SharedTraderPosition>;

  /** Logs */
  private logs: LogEntry[] = [];

  /** Routing statistics */
  private stats: {
    clobExecutions: number;
    lmsrExecutions: number;
    totalOrders: number;
    clobFillQty: Decimal;
    lmsrFillQty: Decimal;
  };

  constructor(config: HybridConfigV2) {
    this.config = config;

    // Initialize CLOB
    this.clobEngine = new CLOBEngine();
    this.clobLedger = this.clobEngine.initLedger([]);

    // Initialize LMSR
    const b = config.lmsrConfig?.b ?? 100;
    this.lmsrEngine = new BinaryLMSR();
    this.lmsrLedger = this.lmsrEngine.initLedger(b, []);

    // Initialize shared positions
    this.sharedPositions = new Map();

    // Initialize stats
    this.stats = {
      clobExecutions: 0,
      lmsrExecutions: 0,
      totalOrders: 0,
      clobFillQty: new Decimal(0),
      lmsrFillQty: new Decimal(0),
    };
  }

  initialize(): void {
    // Reset CLOB
    this.clobLedger = this.clobEngine.initLedger([]);

    // Reset LMSR
    const b = this.config.lmsrConfig?.b ?? 100;
    this.lmsrLedger = this.lmsrEngine.initLedger(b, []);

    // Reset shared positions
    this.sharedPositions.clear();

    // Reset logs and stats
    this.logs = [];
    this.stats = {
      clobExecutions: 0,
      lmsrExecutions: 0,
      totalOrders: 0,
      clobFillQty: new Decimal(0),
      lmsrFillQty: new Decimal(0),
    };
  }

  addTrader(traderId: string, cash: number): void {
    if (!this.sharedPositions.has(traderId)) {
      // Create shared position
      this.sharedPositions.set(traderId, {
        traderId,
        cash: new Decimal(cash),
        yesShares: new Decimal(0),
        noShares: new Decimal(0),
        clobOpenOrders: new Set(),
        lastUpdate: Date.now(),
      });

      // Initialize CLOB trader
      const clobTrader = this.clobEngine.initTrader(traderId, cash);
      this.clobLedger.traders.set(traderId, clobTrader);

      // Initialize LMSR trader
      const lmsrTrader = this.lmsrEngine.initTrader(traderId, cash);
      this.lmsrLedger.traders.set(traderId, lmsrTrader);
    }
  }

  creditShares(traderId: string, outcome: Outcome, qty: number): void {
    // Credit shares to both CLOB and LMSR ledgers
    const clobTrader = this.clobLedger.traders.get(traderId);
    if (clobTrader) {
      if (outcome === "YES") {
        clobTrader.yesShares = clobTrader.yesShares.plus(qty);
      } else {
        clobTrader.noShares = clobTrader.noShares.plus(qty);
      }
    }

    const lmsrTrader = this.lmsrLedger.traders.get(traderId);
    if (lmsrTrader) {
      if (outcome === "YES") {
        lmsrTrader.yesShares = lmsrTrader.yesShares.plus(qty);
      } else {
        lmsrTrader.noShares = lmsrTrader.noShares.plus(qty);
      }
    }

    // Also update shared positions
    const sharedPos = this.sharedPositions.get(traderId);
    if (sharedPos) {
      if (outcome === "YES") {
        sharedPos.yesShares = sharedPos.yesShares.plus(qty);
      } else {
        sharedPos.noShares = sharedPos.noShares.plus(qty);
      }
    }
  }

  /**
   * Process an order - main entry point
   *
   * Strategy: Try CLOB first, then LMSR for any remaining quantity
   */
  processOrder(intent: OrderIntent): ExecutionResult {
    const timestamp = Date.now();
    const intentId = intent.intentId;
    this.stats.totalOrders++;

    // Ensure trader exists with sufficient cash for many orders
    this.addTrader(intent.traderId, 100000);

    // Sync shared position to both engines before processing
    this.syncPositionToEngines(intent.traderId);

    const stateBefore = this.getMarketState();

    try {
      // Determine routing based on mode
      const routingResult = this.routeOrder(intent);

      // Get shared position after execution
      const sharedPosition = this.sharedPositions.get(intent.traderId)!;

      // Build fills from all routing decisions
      const fills: ExecutionResult["fills"] = [];
      let fillIndex = 0;

      for (const decision of routingResult.decisions) {
        fills.push({
          fillId: `${intentId}-fill-${fillIndex++}`,
          intentId,
          traderId: intent.traderId,
          side: intent.side,
          outcome: intent.outcome,
          price: decision.price,
          qty: decision.qty,
          value: decision.price.times(decision.qty),
          counterparty: decision.engine,
          timestamp,
        });
      }

      // Calculate price metrics
      const priceBefore = stateBefore.midPrice ?? null;
      const priceAfter = this.getMarketState().midPrice ?? null;
      const slippage = priceBefore && routingResult.avgFillPrice.gt(0)
        ? calcSlippage(priceBefore, routingResult.avgFillPrice, intent.side)
        : null;
      const priceImpact = priceBefore && priceAfter
        ? calcPriceImpact(priceBefore, priceAfter, intent.side)
        : null;

      // Build result - only include engines that actually filled something
        const usedEngines = routingResult.decisions
          .filter(d => d.qty.gt(0))
          .map(d => d.engine)
          .join("+");
        const engineType = usedEngines
          ? `HYBRID_V2(${usedEngines})`
          : "HYBRID_V2";

        const result: ExecutionResult = {
          engineType,
          intent,
        status: routingResult.finalStatus,
        fills,
        filledQty: routingResult.totalFilledQty,
        remainingQty: routingResult.totalRemainingQty,
        avgFillPrice: routingResult.avgFillPrice,
        priceBefore,
        priceAfter,
        slippage,
        priceImpact,
        deltas: {
          cashChanges: new Map(),
          yesShareChanges: new Map(),
          noShareChanges: new Map(),
          ordersAdded: [],
          ordersRemoved: [],
          ordersModified: [],
        },
        marketState: this.getMarketState(),
        logs: this.collectLogs(intent, routingResult),
        timestamp,
      };

      // Log routing decisions to internal log
      this.logRouting(intent, routingResult);

      return result;
    } catch (e) {
      return this.createRejectedResult(intent, stateBefore, `${e}`);
    }
  }

  // -------------------------------------------------------------------------
  // Routing Logic
  // -------------------------------------------------------------------------

  /**
   * Route an order through the appropriate engines
   */
  private routeOrder(intent: OrderIntent): HybridRoutingResult {
    const decisions: RoutingDecision[] = [];
    let remainingQty = new Decimal(intent.qty ?? intent.spend ?? 0);

    // For spend-based orders, convert to qty
    if (intent.spend && !intent.qty) {
      // Use LMSR to estimate qty
      const lmsrQty = this.estimateQtyFromSpend(intent.spend as number);
      remainingQty = lmsrQty;
    }

    let totalFilledQty = new Decimal(0);
    let totalValue = new Decimal(0);
    let lastEngineUsed: "CLOB" | "LMSR" | undefined = undefined;

    // Based on routing mode, decide how to execute.
    // Both BUY and SELL orders may route through CLOB and/or LMSR.
    // LMSR sells use a native share-returning primitive (not a buy of the opposite outcome).

    // Track the CLOB status to determine final status
    let clobStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED" | null = null;
    let clobRemainingOnBook = new Decimal(0);
    // Track all affected traders (for position sync)
    const affectedTraders = new Set<string>([intent.traderId]);

    // CAPTURE BASELINE positions before execution for proper delta tracking
    const baselinePositions = new Map<string, { cash: Decimal; yesShares: Decimal; noShares: Decimal }>();
    for (const traderId of [intent.traderId]) {
      const clobTrader = this.clobLedger.traders.get(traderId);
      const lmsrTrader = this.lmsrLedger.traders.get(traderId);
      const shared = this.sharedPositions.get(traderId);
      if (shared) {
        baselinePositions.set(traderId, {
          cash: shared.cash,
          yesShares: shared.yesShares,
          noShares: shared.noShares,
        });
      }
    }

    // Route via spread-based predicate: use CLOB when conditions hold,
    // otherwise fall through to LMSR for any unfilled quantity.
    const shouldUseCLOB = this.checkCLOBConditions(intent);

    if (shouldUseCLOB) {
      const clobResult = this.tryExecuteOnCLOB(intent, remainingQty);
      decisions.push(clobResult.decision);
      totalFilledQty = totalFilledQty.plus(clobResult.filledQty);
      totalValue = totalValue.plus(clobResult.value);
      remainingQty = remainingQty.minus(clobResult.filledQty);
      clobStatus = clobResult.status;
      clobRemainingOnBook = clobResult.remainingOnBook;
      if (clobResult.filledQty.gt(0)) {
        lastEngineUsed = "CLOB";
      }
      for (const counterparty of clobResult.counterparties) {
        affectedTraders.add(counterparty);
      }
    }

    // Fall back to LMSR for unfilled quantity — but only when it makes sense.
    // A LIMIT order that was accepted by CLOB is resting on the book at the
    // trader's chosen price; routing its residual to LMSR at a different price
    // would violate the limit-order contract and inflates the reported
    // "fallback rate" in every scenario where limits partially match.
    //
    // Fall back only when:
    //   - CLOB was never attempted (shouldUseCLOB was false), OR
    //   - CLOB rejected the order outright, OR
    //   - the intent was a MARKET order (the trader wants immediate execution).
    const clobAttempted = clobStatus !== null;
    const clobRejected = clobStatus === "REJECTED";
    const isMarket = intent.orderType === "MARKET";
    const shouldFallback =
      remainingQty.gt(0) && (!clobAttempted || clobRejected || isMarket);

    if (shouldFallback) {
      const lmsrResult = this.executeOnLMSR(intent, remainingQty);
      decisions.push(lmsrResult.decision);
      totalFilledQty = totalFilledQty.plus(lmsrResult.filledQty);
      totalValue = totalValue.plus(lmsrResult.value);
      remainingQty = remainingQty.minus(lmsrResult.filledQty);
      if (lmsrResult.filledQty.gt(0)) {
        lastEngineUsed = "LMSR";
      }
    }

    // Update shared positions for all affected traders
    // This includes both the order placer and any counterparties that traded
    for (const traderId of affectedTraders) {
      const baseline = baselinePositions.get(traderId);
      this.syncPositionFromEngines(traderId, lastEngineUsed, baseline);
    }

    const avgFillPrice = totalFilledQty.gt(0)
      ? totalValue.div(totalFilledQty)
      : new Decimal(0);

    // Determine final status based on what actually happened
    let finalStatus: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED";
    if (clobStatus === "OPEN" && totalFilledQty.eq(0)) {
      // Order went on book with no fills
      finalStatus = "OPEN";
    } else if (remainingQty.eq(0)) {
      // All requested quantity was filled (even if some remains on book as resting order)
      finalStatus = "FILLED";
    } else if (totalFilledQty.gt(0)) {
      // Some quantity was filled but not all
      finalStatus = "PARTIALLY_FILLED";
    } else {
      // No quantity was filled
      finalStatus = "REJECTED";
    }

    return {
      decisions,
      totalFilledQty,
      totalRemainingQty: remainingQty,
      avgFillPrice,
      finalStatus,
    };
  }

  /**
   * Check if CLOB conditions are met for execution
   */
  private checkCLOBConditions(intent: OrderIntent): boolean {
    const book = this.clobLedger.market.orderBook;
    const spread = this.clobEngine.getSpread(book);
    const maxSpread = this.config.maxSpread ?? 0.05;
    const minDepth = this.config.minDepth ?? 0;

    // If spread is too wide, use LMSR
    if (spread && spread.gt(maxSpread)) {
      return false;
    }

    // For sells, check if trader has shares of the outcome being sold.
    // SELL YES requires YES inventory; SELL NO requires NO inventory.
    if (intent.side === "SELL") {
      const sharedPos = this.sharedPositions.get(intent.traderId);
      const inventory = intent.outcome === "YES"
        ? sharedPos?.yesShares
        : sharedPos?.noShares;
      if (!inventory || inventory.lte(0)) {
        return false; // No inventory of the outcome being sold
      }
    }

    // For MARKET orders or aggressive orders, check if there's sufficient liquidity depth
    // Skip depth check for limit orders that might rest on book
    if (intent.orderType === "MARKET" && minDepth > 0) {
      const depth = this.clobEngine.getLiquidityDepth(book, intent.side, 3);
      if (depth.lt(minDepth)) {
        return false; // Insufficient depth, use LMSR
      }
    }

    return true;
  }

  /**
   * Try to execute on CLOB
   * Returns the result and any quantity that couldn't be filled
   */
  private tryExecuteOnCLOB(
    intent: OrderIntent,
    qty: Decimal
  ): { decision: RoutingDecision; filledQty: Decimal; value: Decimal; status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED"; remainingOnBook: Decimal; counterparties: Set<string>; } {
    const isBuying = intent.side === "BUY";
    const outcome = intent.outcome;
    const counterparties = new Set<string>();

    // PRE-SYNC: Before executing on CLOB, ensure the CLOB ledger has the trader's latest position
    // This is important when a trader bought on LMSR and now wants to sell on CLOB
    this.syncToCLOBLedger(intent.traderId);

    try {
      let clobResult;

      if (intent.orderType === "MARKET") {
        clobResult = this.clobEngine.placeMarketOrder(
          this.clobLedger,
          intent.traderId,
          isBuying ? "BUY" : "SELL",
          qty
        );
      } else {
        const price = intent.price ?? 0.5;
        clobResult = this.clobEngine.placeLimitOrder(
          this.clobLedger,
          intent.traderId,
          isBuying ? "BUY" : "SELL",
          price,
          qty
        );
      }

      // Update CLOB stats
      if (clobResult.filledQty.gt(0)) {
        this.stats.clobExecutions++;
        this.stats.clobFillQty = this.stats.clobFillQty.plus(clobResult.filledQty);
      }

      // Collect counterparties from trades
      for (const trade of clobResult.trades) {
        if (trade.bidTraderId !== intent.traderId) {
          counterparties.add(trade.bidTraderId);
        }
        if (trade.askTraderId !== intent.traderId) {
          counterparties.add(trade.askTraderId);
        }
      }

      return {
        decision: {
          engine: "CLOB",
          qty: clobResult.filledQty,
          price: clobResult.avgFillPrice,
          engineStatus: clobResult.status,
          reason: `Filled ${clobResult.filledQty} of ${qty}`,
        },
        filledQty: clobResult.filledQty,
        value: clobResult.filledQty.times(clobResult.avgFillPrice),
        status: clobResult.status,
        remainingOnBook: clobResult.remainingQty,
        counterparties,
      };
    } catch (e) {
      return {
        decision: {
          engine: "CLOB",
          qty: new Decimal(0),
          price: new Decimal(0),
          reason: `Error: ${e}`,
        },
        filledQty: new Decimal(0),
        value: new Decimal(0),
        status: "REJECTED",
        remainingOnBook: new Decimal(0),
        counterparties,
      };
    }
  }

  /**
   * Execute on LMSR.
   * BUY: always fills (at some price) via executeBuy / executeBuySpend.
   * SELL: fills up to the trader's share balance via executeSell; may fail
   * if the trader has no shares of the outcome, in which case filledQty=0.
   */
  private executeOnLMSR(
    intent: OrderIntent,
    qty: Decimal
  ): { decision: RoutingDecision; filledQty: Decimal; value: Decimal; } {
    const outcome = intent.outcome;

    try {
      let lmsrResult;

      if (intent.side === "SELL") {
        // Native LMSR sell: cap the requested qty at the trader's current
        // share balance of this outcome. The adapter layer has already
        // synced shared positions into the LMSR ledger.
        const lmsrTrader = this.lmsrLedger.traders.get(intent.traderId);
        const available = lmsrTrader
          ? (outcome === "YES" ? lmsrTrader.yesShares : lmsrTrader.noShares)
          : new Decimal(0);
        const sellQty = Decimal.min(qty, available);
        if (sellQty.lte(0)) {
          return {
            decision: {
              engine: "LMSR",
              qty: new Decimal(0),
              price: new Decimal(0),
              reason: `No ${outcome} shares to sell on LMSR`,
            },
            filledQty: new Decimal(0),
            value: new Decimal(0),
          };
        }
        lmsrResult = this.lmsrEngine.executeSell(
          this.lmsrLedger,
          intent.traderId,
          outcome,
          sellQty.toNumber()
        );
      } else if (intent.spend && !intent.qty) {
        // Spend-based BUY order
        lmsrResult = this.lmsrEngine.executeBuySpend(
          this.lmsrLedger,
          intent.traderId,
          outcome,
          intent.spend as number
        );
      } else {
        // Qty-based BUY order
        lmsrResult = this.lmsrEngine.executeBuy(
          this.lmsrLedger,
          intent.traderId,
          outcome,
          qty.toNumber()
        );
      }

      // Apply result
      this.lmsrLedger.market = lmsrResult.newState;
      this.lmsrLedger.traders.set(intent.traderId, lmsrResult.newTraderAccount);

      // Update LMSR stats
      this.stats.lmsrExecutions++;
      this.stats.lmsrFillQty = this.stats.lmsrFillQty.plus(lmsrResult.qty);

      return {
        decision: {
          engine: "LMSR",
          qty: lmsrResult.qty,
          price: lmsrResult.avgPrice,
          reason: "LMSR execution",
        },
        filledQty: lmsrResult.qty,
        value: lmsrResult.spend,
      };
    } catch (e) {
      return {
        decision: {
          engine: "LMSR",
          qty: new Decimal(0),
          price: new Decimal(0),
          reason: `Error: ${e}`,
        },
        filledQty: new Decimal(0),
        value: new Decimal(0),
      };
    }
  }

  /**
   * Estimate quantity from spend amount using LMSR quote
   */
  private estimateQtyFromSpend(spend: number): Decimal {
    try {
      const quote = this.lmsrEngine.quoteSpendBuy(
        this.lmsrLedger.market,
        "YES",
        spend
      );
      return quote.qty;
    } catch {
      return new Decimal(spend * 2); // Rough estimate
    }
  }

  // -------------------------------------------------------------------------
  // Position Synchronization
  // -------------------------------------------------------------------------

  /**
   * Sync shared position TO engines before execution
   * This ensures both engines have the latest position data
   */
  private syncPositionToEngines(traderId: string): void {
    const shared = this.sharedPositions.get(traderId);
    if (!shared) return;

    // Update CLOB ledger trader
    const clobTrader = this.clobLedger.traders.get(traderId);
    if (clobTrader) {
      clobTrader.cash = shared.cash;
      clobTrader.yesShares = shared.yesShares;
      clobTrader.noShares = shared.noShares;
      clobTrader.openOrders = shared.clobOpenOrders;
    }

    // Update LMSR ledger trader
    const lmsrTrader = this.lmsrLedger.traders.get(traderId);
    if (lmsrTrader) {
      lmsrTrader.cash = shared.cash;
      lmsrTrader.yesShares = shared.yesShares;
      lmsrTrader.noShares = shared.noShares;
    }
  }

  /**
   * Sync shared position FROM engines after execution
   * This captures changes made by either engine
   * @param lastEngineUsed - Which engine executed last (use as primary source)
   */
  private syncPositionFromEngines(
    traderId: string,
    lastEngineUsed?: "CLOB" | "LMSR",
    baseline?: { cash: Decimal; yesShares: Decimal; noShares: Decimal }
  ): void {
    const shared = this.sharedPositions.get(traderId);
    if (!shared) return;

    // Get positions from both engines
    const clobTrader = this.clobLedger.traders.get(traderId);
    const lmsrTrader = this.lmsrLedger.traders.get(traderId);

    // Use CLOB's open orders
    if (clobTrader) {
      shared.clobOpenOrders = clobTrader.openOrders;
    }

    // The last engine used has the most up-to-date cash (reflects all trades in this order)
    if (lastEngineUsed === "CLOB" && clobTrader) {
      shared.cash = clobTrader.cash;
    } else if (lastEngineUsed === "LMSR" && lmsrTrader) {
      shared.cash = lmsrTrader.cash;
    } else if (clobTrader) {
      shared.cash = clobTrader.cash;
    } else if (lmsrTrader) {
      shared.cash = lmsrTrader.cash;
    }

    // For shares: use baseline to compute deltas, then add to baseline
    const baselineYes = baseline?.yesShares ?? shared.yesShares;
    const baselineNo = baseline?.noShares ?? shared.noShares;

    // Calculate how much each engine added/removed
    let clobDeltaYes = new Decimal(0);
    let clobDeltaNo = new Decimal(0);
    let lmsrDeltaYes = new Decimal(0);
    let lmsrDeltaNo = new Decimal(0);

    if (clobTrader) {
      // CLOB shows delta from baseline (either positive or negative)
      clobDeltaYes = clobTrader.yesShares.minus(baselineYes);
      clobDeltaNo = clobTrader.noShares.minus(baselineNo);
    }
    if (lmsrTrader) {
      // LMSR shows delta from baseline (either positive or negative)
      lmsrDeltaYes = lmsrTrader.yesShares.minus(baselineYes);
      lmsrDeltaNo = lmsrTrader.noShares.minus(baselineNo);
    }

    // Sum up all deltas and add to baseline
    shared.yesShares = baselineYes.plus(clobDeltaYes).plus(lmsrDeltaYes);
    shared.noShares = baselineNo.plus(clobDeltaNo).plus(lmsrDeltaNo);

    // Sync full position back to both engines so they have complete view
    if (clobTrader) {
      clobTrader.cash = shared.cash;
      clobTrader.yesShares = shared.yesShares;
      clobTrader.noShares = shared.noShares;
    }
    if (lmsrTrader) {
      lmsrTrader.cash = shared.cash;
      lmsrTrader.yesShares = shared.yesShares;
      lmsrTrader.noShares = shared.noShares;
    }

    shared.lastUpdate = Date.now();
  }

  /**
   * Sync shared position to CLOB ledger before executing on CLOB
   * This ensures that shares bought on LMSR are available for selling on CLOB
   */
  private syncToCLOBLedger(traderId: string): void {
    const shared = this.sharedPositions.get(traderId);
    if (!shared) return;

    const clobTrader = this.clobLedger.traders.get(traderId);
    if (!clobTrader) return;

    // Sync shared position to CLOB ledger
    clobTrader.cash = shared.cash;
    clobTrader.yesShares = shared.yesShares;
    clobTrader.noShares = shared.noShares;
    // Note: Don't sync clobOpenOrders - that's CLOB-specific state
  }

  /**
   * After multi-engine execution, aggregate positions from both engines
   * This is needed because both CLOB and LMSR may have updated the trader's position
   */
  private aggregateAndSyncPositions(traderId: string, lastEngineUsed?: "CLOB" | "LMSR"): void {
    const shared = this.sharedPositions.get(traderId);
    if (!shared) return;

    const clobTrader = this.clobLedger.traders.get(traderId);
    const lmsrTrader = this.lmsrLedger.traders.get(traderId);

    // Use CLOB's open orders
    if (clobTrader) {
      shared.clobOpenOrders = clobTrader.openOrders;
    }

    // Aggregate positions from both engines
    // Cash and shares should be the same in both engines (after sync),
    // so we can use either as source. Use the last-used engine for consistency.
    const primaryEngine = lastEngineUsed ?? "CLOB";
    const primaryTrader = primaryEngine === "CLOB" ? clobTrader : lmsrTrader;

    if (primaryTrader) {
      shared.cash = primaryTrader.cash;
      shared.yesShares = primaryTrader.yesShares;
      shared.noShares = primaryTrader.noShares;
    }

    // Ensure the other engine is synced to the same position
    if (primaryEngine === "CLOB" && lmsrTrader) {
      lmsrTrader.cash = shared.cash;
      lmsrTrader.yesShares = shared.yesShares;
      lmsrTrader.noShares = shared.noShares;
    } else if (primaryEngine === "LMSR" && clobTrader) {
      clobTrader.cash = shared.cash;
      clobTrader.yesShares = shared.yesShares;
      clobTrader.noShares = shared.noShares;
    }

    shared.lastUpdate = Date.now();
  }

  // -------------------------------------------------------------------------
  // Market State
  // -------------------------------------------------------------------------

  getMarketState(): MarketStateSnapshot {
    const clobState = this.getCLOBState();
    const lmsrState = this.getLMSRState();

    // Prefer CLOB mid when the book is two-sided; fall back to LMSR only if it
    // has actually traded (q != 0). An untouched LMSR reports a vacuous 0.5,
    // which would otherwise mask a truly undefined mid.
    const lmsrTouched =
      this.lmsrLedger.market.qYes.gt(0) || this.lmsrLedger.market.qNo.gt(0);
    const midPrice = clobState.midPrice ?? (lmsrTouched ? lmsrState.midPrice : undefined);

    return {
      timestamp: Date.now(),
      engineType: this.engineType,
      midPrice: midPrice ?? undefined,
      bestBid: clobState.bestBid,
      bestAsk: clobState.bestAsk,
      spread: clobState.spread,
      priceYes: lmsrState.priceYes,
      priceNo: lmsrState.priceNo,
      bidDepth: clobState.bidDepth,
      askDepth: clobState.askDepth,
      qYes: lmsrState.qYes,
      qNo: lmsrState.qNo,
    };
  }

  private getCLOBState(): MarketStateSnapshot {
    const book = this.clobLedger.market.orderBook;
    return {
      timestamp: Date.now(),
      engineType: "CLOB",
      bestBid: this.clobEngine.getBestBid(book) ?? undefined,
      bestAsk: this.clobEngine.getBestAsk(book) ?? undefined,
      spread: this.clobEngine.getSpread(book) ?? undefined,
      midPrice: this.clobEngine.getMidPrice(book) ?? undefined,
      bidDepth: this.clobEngine.getDepth(book, "BUY", 1) ?? undefined,
      askDepth: this.clobEngine.getDepth(book, "SELL", 1) ?? undefined,
    };
  }

  private getLMSRState(): MarketStateSnapshot {
    const prices = this.lmsrEngine.getPrices(this.lmsrLedger.market);
    return {
      timestamp: Date.now(),
      engineType: "LMSR",
      priceYes: prices.pYES,
      priceNo: prices.pNO,
      midPrice: prices.pYES,
      qYes: this.lmsrLedger.market.qYes,
      qNo: this.lmsrLedger.market.qNo,
    };
  }

  getTraderState(traderId: string): import("./engine-common").TraderState | null {
    const shared = this.sharedPositions.get(traderId);
    if (!shared) return null;

    return {
      traderId: shared.traderId,
      cash: shared.cash,
      yesShares: shared.yesShares,
      noShares: shared.noShares,
      openOrders: shared.clobOpenOrders.size,
      totalTrades: 0, // Not tracked in hybrid
      totalVolume: new Decimal(0),
      totalValue: new Decimal(0),
    };
  }

  getAllTraderStates(): Map<string, import("./engine-common").TraderState> {
    const map = new Map<string, import("./engine-common").TraderState>();
    for (const [id, pos] of this.sharedPositions) {
      const state = this.getTraderState(id);
      if (state) map.set(id, state);
    }
    return map;
  }

  reset(): void {
    this.initialize();
  }

  // -------------------------------------------------------------------------
  // Market Data Accessors (prefer CLOB when available)
  // -------------------------------------------------------------------------

  getMidPrice(): Decimal | null {
    const clobMid = this.clobEngine.getMidPrice(this.clobLedger.market.orderBook);
    if (clobMid) return clobMid;
    const lmsrTouched =
      this.lmsrLedger.market.qYes.gt(0) || this.lmsrLedger.market.qNo.gt(0);
    return lmsrTouched ? this.lmsrEngine.getPrices(this.lmsrLedger.market).pYES : null;
  }

  getBestBid(): Decimal | null {
    return this.clobEngine.getBestBid(this.clobLedger.market.orderBook) ?? null;
  }

  getBestAsk(): Decimal | null {
    return this.clobEngine.getBestAsk(this.clobLedger.market.orderBook) ?? null;
  }

  getSpread(): Decimal | null {
    return this.clobEngine.getSpread(this.clobLedger.market.orderBook) ?? null;
  }

  getDepth(side: Side, ticks: number): Decimal {
    // Returns liquidity depth (opposite side) - for BUY, returns ask depth
    return this.clobEngine.getLiquidityDepth(this.clobLedger.market.orderBook, side, ticks);
  }

  cancelOrder(orderId: string): ExecutionResult | null {
    const timestamp = Date.now();
    const stateBefore = this.getMarketState();

    try {
      const result = this.clobEngine.cancelOrder(this.clobLedger, orderId);

      // Update shared position
      const traderId = result.trades.find(t => t.bidTraderId)?.bidTraderId ??
                       result.trades.find(t => t.askTraderId)?.askTraderId;
      if (traderId) {
        this.syncPositionFromEngines(traderId);
      }

      return {
        engineType: this.engineType,
        intent: {
          intentId: `cancel-${orderId}`,
          traderId: traderId ?? "unknown",
          outcome: "YES",
          side: "BUY",
          orderType: "LIMIT",
          timestamp,
        } as OrderIntent,
        status: result.status === "CANCELLED" ? "CANCELLED" : "REJECTED",
        fills: [],
        filledQty: result.filledQty,
        remainingQty: result.remainingQty,
        avgFillPrice: result.avgFillPrice,
        priceBefore: stateBefore.midPrice ?? null,
        priceAfter: this.getMarketState().midPrice ?? null,
        slippage: null,
        priceImpact: null,
        deltas: {
          cashChanges: new Map(),
          yesShareChanges: new Map(),
          noShareChanges: new Map(),
          ordersAdded: [],
          ordersRemoved: [orderId],
          ordersModified: [],
        },
        marketState: this.getMarketState(),
        logs: [],
        timestamp,
      };
    } catch (e) {
      return null;
    }
  }

  getLogs(): readonly LogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }

  // -------------------------------------------------------------------------
  // Statistics and Info
  // -------------------------------------------------------------------------

  getStats() {
    return {
      ...this.stats,
      clobRatio: this.stats.totalOrders > 0
        ? this.stats.clobExecutions / this.stats.totalOrders
        : 0,
    };
  }

  getSharedPositions(): Map<string, SharedTraderPosition> {
    return new Map(this.sharedPositions);
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  private logRouting(intent: OrderIntent, result: HybridRoutingResult): void {
    for (const decision of result.decisions) {
      this.logs.push({
        type: "ROUTING_DECISION",
        timestamp: Date.now(),
        engineType: this.engineType,
        data: {
          intentId: intent.intentId,
          engine: decision.engine,
          qty: decision.qty,
          price: decision.price,
          reason: decision.reason,
        },
      });
    }
  }

  private collectLogs(intent: OrderIntent, result: HybridRoutingResult): LogEntry[] {
    const logs: LogEntry[] = [];

    logs.push({
      type: "ORDER_RECEIVED",
      timestamp: intent.timestamp,
      engineType: this.engineType,
      data: intent,
    });

    // Add routing decision logs
    for (const decision of result.decisions) {
      logs.push({
        type: "ROUTING_DECISION",
        timestamp: Date.now(),
        engineType: this.engineType,
        data: {
          intentId: intent.intentId,
          engine: decision.engine,
          qty: decision.qty,
          price: decision.price,
          reason: decision.reason,
        },
      });
    }

    const logType = result.finalStatus === "OPEN" ? "ORDER_PLACED"
      : result.finalStatus === "FILLED" ? "ORDER_FILLED"
      : result.finalStatus === "PARTIALLY_FILLED" ? "ORDER_PARTIALLY_FILLED"
      : "ORDER_REJECTED";

    logs.push({
      type: logType,
      timestamp: Date.now(),
      engineType: this.engineType,
      data: {
        intentId: intent.intentId,
        filledQty: result.totalFilledQty,
        remainingQty: result.totalRemainingQty,
        avgPrice: result.avgFillPrice,
        engines: result.decisions.map(d => d.engine),
      },
    });

    return logs;
  }

  private createRejectedResult(
    intent: OrderIntent,
    stateBefore: MarketStateSnapshot,
    error: string
  ): ExecutionResult {
    return {
      engineType: this.engineType,
      intent,
      status: "REJECTED",
      fills: [],
      filledQty: new Decimal(0),
      remainingQty: new Decimal(intent.qty ?? 0),
      avgFillPrice: new Decimal(0),
      priceBefore: stateBefore.midPrice ?? null,
      priceAfter: stateBefore.midPrice ?? null,
      slippage: null,
      priceImpact: null,
      deltas: {
        cashChanges: new Map(),
        yesShareChanges: new Map(),
        noShareChanges: new Map(),
        ordersAdded: [],
        ordersRemoved: [],
        ordersModified: [],
      },
      marketState: stateBefore,
      logs: [{
        type: "ERROR",
        timestamp: Date.now(),
        engineType: this.engineType,
        data: { error, intentId: intent.intentId },
      }],
      timestamp: Date.now(),
    };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createHybridEngineV2(config: Omit<Partial<HybridConfigV2>, 'type'> = {}): HybridRouterV2 {
  const fullConfig: HybridConfigV2 = {
    type: "HYBRID_V2",
    maxSpread: config.maxSpread ?? 0.05,
    minDepth: config.minDepth ?? 10,
    depthTicks: config.depthTicks ?? 3,
    clobConfig: config.clobConfig ?? {},
    lmsrConfig: config.lmsrConfig ?? { b: 100 },
  };

  return new HybridRouterV2(fullConfig);
}

/**
 * Create a spread-based hybrid config (uses CLOB when spread is tight)
 */
export function createSpreadBasedConfig(maxSpread: number = 0.03): Omit<Partial<HybridConfigV2>, 'type'> {
  return {
    maxSpread,
    minDepth: 5,
    depthTicks: 3,
    lmsrConfig: { b: 100 },
  };
}

/**
 * Create a hybrid config (for backward compatibility with v1)
 * Maps v1-style config to v2's Partial<HybridConfigV2>
 */
export function createHybridConfig(params: {
  spreadThreshold?: number;
  depthThreshold?: number;
  depthTicks?: number;
  b?: number;
  tickSize?: number;
}): Omit<Partial<HybridConfigV2>, 'type'> {
  return {
    maxSpread: params.spreadThreshold ?? 0.05,
    minDepth: params.depthThreshold ?? 10,
    depthTicks: params.depthTicks ?? 3,
    clobConfig: {
      tickSize: params.tickSize ?? 0.01,
    },
    lmsrConfig: {
      b: params.b ?? 100,
    },
  };
}
