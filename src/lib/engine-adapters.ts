/**
 * Engine Adapters
 *
 * Adapts CLOB and LMSR engines to implement the UnifiedEngine interface,
 * enabling apples-to-apples comparison via the simulation runner.
 */

import { Decimal } from "decimal.js";
import {
  lmsr,
  BinaryLMSR,
  MarketState as LMSRMarketState,
  TraderAccount as LMSRTraderAccount,
  Ledger as LMSRLedger,
  QuoteQty,
  QuoteSpend,
  ExecutionResult as LMSRExecutionResult,
  SettlementResult,
} from "./binaryLmsr";
import {
  CLOBEngine,
  CLOBLedger,
  CLOBMarketState,
  TraderAccount as CLOBTraderAccount,
  LimitOrder,
  Trade as CLOBTrade,
  OrderResult as CLOBOrderResult,
  OrderBook,
  PriceLevel,
} from "./clob";
import {
  UnifiedEngine,
  EngineConfig,
  OrderIntent,
  ExecutionResult,
  MarketStateSnapshot,
  TraderState,
  LogEntry,
  Side,
  Outcome,
  OrderType,
  calcMidPrice,
  calcSlippage,
  calcPriceImpact,
} from "./engine-common";

// ============================================================================
// Helper Functions for Deep Cloning (preserving Maps)
// ============================================================================

/**
 * Deep clone a CLOB ledger, properly reconstructing Maps from JSON serialization
 */
function cloneCLOBLedger(ledger: CLOBLedger): CLOBLedger {
  const serialized = JSON.parse(JSON.stringify(ledger));

  // Reconstruct OrderBook Maps
  const orderBook: OrderBook = {
    bids: new Map(),
    asks: new Map(),
  };

  // Reconstruct bids (price -> PriceLevel)
  if (serialized.market.orderBook.bids) {
    for (const [price, level] of Object.entries(serialized.market.orderBook.bids)) {
      const typedLevel = level as any;
      // Convert Decimal strings back to Decimal objects
      const reconstructedLevel: PriceLevel = {
        price: new Decimal(typedLevel.price),
        side: typedLevel.side,
        totalQty: new Decimal(typedLevel.totalQty),
        orders: typedLevel.orders.map((o: any) => ({
          ...o,
          price: new Decimal(o.price),
          qty: new Decimal(o.qty),
          originalQty: new Decimal(o.originalQty),
        })),
      };
      orderBook.bids.set(price, reconstructedLevel);
    }
  }

  // Reconstruct asks
  if (serialized.market.orderBook.asks) {
    for (const [price, level] of Object.entries(serialized.market.orderBook.asks)) {
      const typedLevel = level as any;
      const reconstructedLevel: PriceLevel = {
        price: new Decimal(typedLevel.price),
        side: typedLevel.side,
        totalQty: new Decimal(typedLevel.totalQty),
        orders: typedLevel.orders.map((o: any) => ({
          ...o,
          price: new Decimal(o.price),
          qty: new Decimal(o.qty),
          originalQty: new Decimal(o.originalQty),
        })),
      };
      orderBook.asks.set(price, reconstructedLevel);
    }
  }

  // Reconstruct bestBid/bestAsk if they exist
  if (serialized.market.orderBook.bestBid) {
    orderBook.bestBid = {
      price: new Decimal(serialized.market.orderBook.bestBid.price),
      side: serialized.market.orderBook.bestBid.side,
      totalQty: new Decimal(serialized.market.orderBook.bestBid.totalQty),
      orders: serialized.market.orderBook.bestBid.orders.map((o: any) => ({
        ...o,
        price: new Decimal(o.price),
        qty: new Decimal(o.qty),
        originalQty: new Decimal(o.originalQty),
      })),
    };
  }
  if (serialized.market.orderBook.bestAsk) {
    orderBook.bestAsk = {
      price: new Decimal(serialized.market.orderBook.bestAsk.price),
      side: serialized.market.orderBook.bestAsk.side,
      totalQty: new Decimal(serialized.market.orderBook.bestAsk.totalQty),
      orders: serialized.market.orderBook.bestAsk.orders.map((o: any) => ({
        ...o,
        price: new Decimal(o.price),
        qty: new Decimal(o.qty),
        originalQty: new Decimal(o.originalQty),
      })),
    };
  }

  // Reconstruct market state
  const market: CLOBMarketState = {
    orderBook,
    lastTradePrice: serialized.market.lastTradePrice ? new Decimal(serialized.market.lastTradePrice) : undefined,
    tradeIdCounter: serialized.market.tradeIdCounter,
    orderIdCounter: serialized.market.orderIdCounter,
    settled: serialized.market.settled,
  };

  // Reconstruct traders Map
  const traders = new Map<string, CLOBTraderAccount>();
  if (serialized.traders) {
    for (const [traderId, account] of Object.entries(serialized.traders)) {
      traders.set(traderId, {
        traderId: (account as any).traderId,
        cash: new Decimal((account as any).cash),
        yesShares: new Decimal((account as any).yesShares),
        noShares: new Decimal((account as any).noShares),
        openOrders: new Set((account as any).openOrders || []),
      });
    }
  }

  return { market, traders };
}

/**
 * Deep clone an LMSR ledger, properly reconstructing Maps from JSON serialization
 */
function cloneLMSRLedger(ledger: LMSRLedger): LMSRLedger {
  const serialized = JSON.parse(JSON.stringify(ledger));

  // Reconstruct traders Map
  const traders = new Map<string, LMSRTraderAccount>();
  if (serialized.traders) {
    for (const [traderId, account] of Object.entries(serialized.traders)) {
      traders.set(traderId, {
        traderId: (account as any).traderId,
        cash: new Decimal((account as any).cash),
        yesShares: new Decimal((account as any).yesShares),
        noShares: new Decimal((account as any).noShares),
      });
    }
  }

  // Reconstruct market state (no Maps here, just Decimals)
  const market: LMSRMarketState = {
    b: serialized.market.b,
    qYes: new Decimal(serialized.market.qYes),
    qNo: new Decimal(serialized.market.qNo),
    totalCollected: new Decimal(serialized.market.totalCollected ?? 0),
    settled: serialized.market.settled ?? false,
  };

  return { market, traders };
}

// ============================================================================
// CLOB Engine Adapter
// ============================================================================

export class CLOBEngineAdapter implements UnifiedEngine {
  readonly engineType = "CLOB";
  readonly config: EngineConfig;

  private engine: CLOBEngine;
  private ledger: CLOBLedger;
  private initialState: CLOBLedger;
  private logs: LogEntry[] = [];
  private traderSnapshots: Map<string, TraderState> = new Map();
  private orderMap: Map<string, string> = new Map(); // intentId -> orderId

  constructor(config: EngineConfig) {
    this.config = config;
    this.engine = new CLOBEngine();
    // Initialize with empty ledger
    this.ledger = this.engine.initLedger([]);
    // Deep clone for initial state, properly reconstructing Maps
    this.initialState = cloneCLOBLedger(this.ledger);
  }

  initialize(): void {
    // Reset to initial state using proper deep clone
    this.ledger = cloneCLOBLedger(this.initialState);
    this.logs = [];
    this.traderSnapshots.clear();
    this.orderMap.clear();
  }

  addTrader(traderId: string, cash: number): void {
    if (!this.ledger.traders.has(traderId)) {
      const account = this.engine.initTrader(traderId, cash);
      this.ledger.traders.set(traderId, account);
      // Don't modify initialState - traders are added during simulation
    }
  }

  creditShares(traderId: string, outcome: Outcome, qty: number): void {
    const trader = this.ledger.traders.get(traderId);
    if (trader) {
      if (outcome === "YES") {
        trader.yesShares = trader.yesShares.plus(qty);
      } else {
        trader.noShares = trader.noShares.plus(qty);
      }
    }
  }

  processOrder(intent: OrderIntent): ExecutionResult {
    const timestamp = Date.now();
    const intentId = intent.intentId;

    // Note: Traders are initialized upfront by the simulation runner
    // with the scenario's initialCash. Throw error if trader not found.
    if (!this.ledger.traders.has(intent.traderId)) {
      throw new Error(`Trader ${intent.traderId} not initialized. Simulation runner should initialize all traders.`);
    }

    const outcome = intent.outcome; // "YES" or "NO"
    const side = intent.side; // "BUY" or "SELL"

    let clobResult: CLOBOrderResult;

    // Get market state before
    const stateBefore = this.getMarketState();

    try {
      if (intent.orderType === "MARKET") {
        // MARKET orders: Execute immediately at best available price
        const qty = intent.qty ?? intent.spend ?? 0;

        if (outcome === "YES") {
          // YES trades are straightforward
          clobResult = this.engine.placeMarketOrder(
            this.ledger,
            intent.traderId,
            side,
            qty
          );
        } else {
          // NO trades: In prediction markets, NO is the complement of YES
          // BUY + NO = SELL + YES (selling YES short at market)
          // SELL + NO = BUY + YES (buying YES to cover short or convert position)
          const convertedSide = side === "BUY" ? "SELL" : "BUY";
          clobResult = this.engine.placeMarketOrder(
            this.ledger,
            intent.traderId,
            convertedSide,
            qty
          );
        }
      } else {
        // LIMIT orders: Place at specified price
        const price = intent.price ?? 0.5;
        const qty = intent.qty ?? intent.spend ?? 0;

        if (outcome === "YES") {
          // YES trades at specified price (standard)
          clobResult = this.engine.placeLimitOrder(
            this.ledger,
            intent.traderId,
            side,
            price,
            qty
          );
        } else {
          // NO trades: Price is the complement
          // If someone wants to BUY NO at price 0.30, they're willing to SELL YES at 0.70 (1 - 0.30)
          // If someone wants to SELL NO at price 0.30, they're willing to BUY YES at 0.70
          const convertedPrice = new Decimal(1).minus(price);
          const convertedSide = side === "BUY" ? "SELL" : "BUY";

          clobResult = this.engine.placeLimitOrder(
            this.ledger,
            intent.traderId,
            convertedSide,
            convertedPrice,
            qty
          );
        }
      }

      // Map order ID
      if (clobResult.orderId) {
        this.orderMap.set(intentId, clobResult.orderId);
      }
    } catch (e) {
      return this.createRejectedResult(intent, stateBefore, `${e}`);
    }

    // Get market state after
    const stateAfter = this.getMarketState();

    // Convert fills
    const fills = clobResult.trades.map((t, i) => {
      const fillId = `${intentId}-fill-${i}`;
      const price = new Decimal(t.price);
      const qty = new Decimal(t.qty);
      const value = price.times(qty);
      return {
        fillId,
        intentId,
        traderId: intent.traderId,
        side: intent.side,
        outcome: intent.outcome,
        price,
        qty,
        value,
        counterparty: t.bidTraderId === intent.traderId ? t.askTraderId : t.bidTraderId,
        timestamp: timestamp,
      };
    });

    // Calculate reference price (mid-price at submission)
    const referencePrice = stateBefore.midPrice ?? null;

    // Calculate slippage
    const avgFillPrice = clobResult.avgFillPrice;
    const slippage = referencePrice
      ? calcSlippage(referencePrice, avgFillPrice, intent.side)
      : null;

    // Calculate price impact
    const priceBefore = stateBefore.midPrice ?? null;
    const priceAfter = stateAfter.midPrice ?? null;
    const priceImpact = priceBefore && priceAfter
      ? calcPriceImpact(priceBefore, priceAfter, intent.side)
      : null;

    // Create result
    const result: ExecutionResult = {
      engineType: this.engineType,
      intent,
      status: this.convertStatus(clobResult.status),
      fills,
      filledQty: clobResult.filledQty,
      remainingQty: clobResult.remainingQty,
      avgFillPrice,
      priceBefore,
      priceAfter,
      slippage,
      priceImpact,
      deltas: this.computeDeltas(intent, clobResult),
      marketState: stateAfter,
      logs: this.collectLogs(intent, clobResult),
      timestamp,
    };

    // Update trader snapshot
    this.updateTraderSnapshot(intent.traderId);

    return result;
  }

  getMarketState(): MarketStateSnapshot {
    const book = this.ledger.market.orderBook;
    const bestBid = this.engine.getBestBid(book);
    const bestAsk = this.engine.getBestAsk(book);
    const spread = this.engine.getSpread(book);
    const midPrice = this.engine.getMidPrice(book);
    const bidDepth = this.engine.getDepth(book, "BUY", 1);
    const askDepth = this.engine.getDepth(book, "SELL", 1);

    return {
      timestamp: Date.now(),
      engineType: this.engineType,
      midPrice: midPrice ?? undefined,
      bestBid: bestBid ?? undefined,
      bestAsk: bestAsk ?? undefined,
      spread: spread ?? undefined,
      bidDepth: bidDepth ?? undefined,
      askDepth: askDepth ?? undefined,
    };
  }

  getTraderState(traderId: string): TraderState | null {
    const trader = this.ledger.traders.get(traderId);
    if (!trader) return null;

    return {
      traderId,
      cash: trader.cash,
      yesShares: trader.yesShares,
      noShares: trader.noShares,
      openOrders: trader.openOrders.size,
      totalTrades: 0, // Not tracked in CLOB
      totalVolume: new Decimal(0),
      totalValue: new Decimal(0),
    };
  }

  getAllTraderStates(): Map<string, TraderState> {
    const map = new Map<string, TraderState>();
    for (const [id, trader] of this.ledger.traders) {
      const state = this.getTraderState(id);
      if (state) map.set(id, state);
    }
    return map;
  }

  reset(): void {
    this.initialize();
  }

  getMidPrice(): Decimal | null {
    const book = this.ledger.market.orderBook;
    return this.engine.getMidPrice(book) ?? null;
  }

  getBestBid(): Decimal | null {
    const book = this.ledger.market.orderBook;
    return this.engine.getBestBid(book) ?? null;
  }

  getBestAsk(): Decimal | null {
    const book = this.ledger.market.orderBook;
    return this.engine.getBestAsk(book) ?? null;
  }

  getSpread(): Decimal | null {
    const book = this.ledger.market.orderBook;
    return this.engine.getSpread(book) ?? null;
  }

  getDepth(side: Side, ticks: number): Decimal {
    const book = this.ledger.market.orderBook;
    return this.engine.getDepth(book, side, ticks);
  }

  cancelOrder(orderId: string): ExecutionResult | null {
    const intentId = `cancel-${orderId}`;
    const timestamp = Date.now();
    const stateBefore = this.getMarketState();

    try {
      const result = this.engine.cancelOrder(this.ledger, orderId);
      const stateAfter = this.getMarketState();

      return {
        engineType: this.engineType,
        intent: {
          intentId,
          traderId: "",
          outcome: "YES",
          side: "BUY",
          orderType: "LIMIT",
          timestamp,
        } as OrderIntent,
        status: this.convertStatus(result.status),
        fills: [],
        filledQty: result.filledQty,
        remainingQty: result.remainingQty,
        avgFillPrice: result.avgFillPrice,
        priceBefore: stateBefore.midPrice ?? null,
        priceAfter: stateAfter.midPrice ?? null,
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
        marketState: stateAfter,
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
  // Private Helpers
  // -------------------------------------------------------------------------

  private convertStatus(status: string): "FILLED" | "PARTIALLY_FILLED" | "REJECTED" | "CANCELLED" {
    switch (status) {
      case "OPEN":
        return "PARTIALLY_FILLED";
      case "FILLED":
        return "FILLED";
      case "PARTIALLY_FILLED":
        return "PARTIALLY_FILLED";
      case "CANCELLED":
        return "CANCELLED";
      default:
        return "REJECTED";
    }
  }

  private computeDeltas(
    intent: OrderIntent,
    result: CLOBOrderResult
  ): ExecutionResult["deltas"] {
    const cashChanges = new Map<string, Decimal>();
    const yesShareChanges = new Map<string, Decimal>();
    const noShareChanges = new Map<string, Decimal>();
    const ordersAdded: string[] = [];
    const ordersRemoved: string[] = [];
    const ordersModified: string[] = [];

    const traderId = intent.traderId;

    // Track order status changes
    if (result.orderId) {
      if (result.status === "OPEN") {
        ordersAdded.push(result.orderId);
      } else if (result.status === "FILLED") {
        ordersRemoved.push(result.orderId);
      } else if (result.status === "PARTIALLY_FILLED") {
        ordersModified.push(result.orderId);
      }
    }

    // Track fill-based changes (already applied in engine)
    for (const trade of result.trades) {
      // Note: CLOB engine already updates balances during matching
      // We just need to track what changed
    }

    return {
      cashChanges,
      yesShareChanges,
      noShareChanges,
      ordersAdded,
      ordersRemoved,
      ordersModified,
    };
  }

  private collectLogs(intent: OrderIntent, result: CLOBOrderResult): LogEntry[] {
    const logs: LogEntry[] = [];

    // Order received
    logs.push({
      type: "ORDER_RECEIVED",
      timestamp: intent.timestamp,
      engineType: this.engineType,
      data: intent,
    });

    // Order result
    logs.push({
      type: result.status === "CANCELLED" ? "ORDER_CANCELLED" :
            result.filledQty.eq(intent.qty ?? 0) ? "ORDER_FILLED" : "ORDER_PARTIALLY_FILLED",
      timestamp: Date.now(),
      engineType: this.engineType,
      data: { intentId: intent.intentId, status: result.status },
    });

    // Trade logs
    for (const trade of result.trades) {
      logs.push({
        type: "TRADE_EXECUTED",
        timestamp: Date.now(),
        engineType: this.engineType,
        data: trade,
      });
    }

    return logs;
  }

  private updateTraderSnapshot(traderId: string): void {
    const trader = this.ledger.traders.get(traderId);
    if (trader) {
      this.traderSnapshots.set(traderId, {
        traderId,
        cash: trader.cash,
        yesShares: trader.yesShares,
        noShares: trader.noShares,
        openOrders: trader.openOrders.size,
        totalTrades: 0,
        totalVolume: new Decimal(0),
        totalValue: new Decimal(0),
      });
    }
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
// LMSR Engine Adapter
// ============================================================================

export class LMSREngineAdapter implements UnifiedEngine {
  readonly engineType = "LMSR";
  readonly config: EngineConfig;

  private engine: BinaryLMSR;
  private ledger: LMSRLedger;
  private initialState: LMSRLedger;
  private logs: LogEntry[] = [];
  private traderStats: Map<string, { trades: number; volume: Decimal; value: Decimal; }>;

  constructor(config: EngineConfig) {
    this.config = config;
    this.engine = new BinaryLMSR();
    const b = config.liquidity ?? 100;
    this.ledger = this.engine.initLedger(b, []);
    // Deep clone for initial state, properly reconstructing Maps
    this.initialState = cloneLMSRLedger(this.ledger);
    this.traderStats = new Map();
  }

  initialize(): void {
    // Reset to initial state using proper deep clone
    this.ledger = cloneLMSRLedger(this.initialState);
    this.logs = [];
    this.traderStats.clear();
  }

  addTrader(traderId: string, cash: number): void {
    if (!this.ledger.traders.has(traderId)) {
      const account = this.engine.initTrader(traderId, cash);
      this.ledger.traders.set(traderId, account);
      // Don't modify initialState
    }
    this.traderStats.set(traderId, { trades: 0, volume: new Decimal(0), value: new Decimal(0) });
  }

  creditShares(traderId: string, outcome: Outcome, qty: number): void {
    // LMSR doesn't need pre-seeding - market maker always accepts orders
    // This is a no-op for LMSR
  }

  processOrder(intent: OrderIntent): ExecutionResult {
    const timestamp = Date.now();
    const intentId = intent.intentId;

    // Note: Traders are initialized upfront by the simulation runner
    // with the scenario's initialCash. Throw error if trader not found.
    if (!this.ledger.traders.has(intent.traderId)) {
      throw new Error(`Trader ${intent.traderId} not initialized. Simulation runner should initialize all traders.`);
    }

    const stateBefore = this.getMarketState();

    try {
      let lmsrResult: LMSRExecutionResult;
      const outcome = intent.outcome; // "YES" or "NO"
      const side = intent.side; // "BUY" or "SELL"

      const qty = intent.qty ?? 0;
      const spend = intent.spend ?? 0;
      const qtyNum = typeof qty === "number" ? qty : qty.toNumber();
      const spendNum = typeof spend === "number" ? spend : spend.toNumber();

      if (side === "SELL") {
        // Native LMSR sell: trader returns shares of `outcome` to the market
        // and receives cash C(q) - C(q'). Qty-based only; MARKET and LIMIT both
        // consume the trader's share balance up to qty.
        const actualQty = qtyNum > 0 ? qtyNum : spendNum * 2;
        lmsrResult = this.engine.executeSell(
          this.ledger,
          intent.traderId,
          outcome,
          actualQty
        );
      } else if (
        intent.orderType === "MARKET" &&
        spendNum > 0 &&
        !(intent.qty && qtyNum > 0)
      ) {
        // BUY MARKET with an explicit spend budget (no qty): budget-capped
        // purchase via the LMSR cost function.
        const trader = this.ledger.traders.get(intent.traderId);
        const availableCash = trader ? trader.cash.toNumber() : 0;
        if (spendNum > availableCash) {
          return this.createRejectedResult(intent, stateBefore, "Insufficient cash");
        }
        lmsrResult = this.engine.executeBuySpend(
          this.ledger,
          intent.traderId,
          outcome,
          spendNum
        );
      } else {
        // BUY (LIMIT, or MARKET with qty given): quantity-based execution.
        // The old code approximated spend as qty*0.5 for qty-only MARKET
        // BUYs, which under-funded the purchase whenever the mid was not 0.5
        // (e.g. Thin scenarios with mid ~0.85). Dispatching on `executeBuy`
        // pays whatever the LMSR cost function demands; insufficient-cash is
        // thrown by the engine and caught below.
        const actualQty = qtyNum > 0 ? qtyNum : spendNum * 2;
        lmsrResult = this.engine.executeBuy(
          this.ledger,
          intent.traderId,
          outcome,
          actualQty
        );
      }

      // Apply the result
      this.ledger.market = lmsrResult.newState;
      this.ledger.traders.set(intent.traderId, lmsrResult.newTraderAccount);

      // Update trader stats
      const stats = this.traderStats.get(intent.traderId)!;
      stats.trades += 1;
      stats.volume = stats.volume.plus(lmsrResult.qty);
      stats.value = stats.value.plus(lmsrResult.spend);

      // Convert to ExecutionResult format
      const fills = [{
        fillId: `${intentId}-fill-0`,
        intentId,
        traderId: intent.traderId,
        side: intent.side,
        outcome,
        price: lmsrResult.avgPrice,
        qty: lmsrResult.qty,
        value: lmsrResult.spend,
        timestamp,
      }];

      const priceBefore = stateBefore.priceYes ?? null;
      const priceAfter = lmsrResult.pricesAfter.yes ?? null;

      // For SELL, cash change is a credit (+receipt); yesShares/noShares decrease.
      // For BUY, cash change is a debit (-spend); shares increase.
      const cashDelta = side === "SELL" ? lmsrResult.spend : lmsrResult.spend.neg();
      const shareDelta = side === "SELL" ? lmsrResult.qty.neg() : lmsrResult.qty;

      // Slippage / price impact now derivable because priceBefore is known.
      const slippage = priceBefore
        ? calcSlippage(priceBefore, lmsrResult.avgPrice, intent.side)
        : null;
      const priceImpact = priceBefore && priceAfter
        ? calcPriceImpact(priceBefore, priceAfter, intent.side)
        : null;

      return {
        engineType: this.engineType,
        intent,
        status: "FILLED",
        fills,
        filledQty: lmsrResult.qty,
        remainingQty: new Decimal(0),
        avgFillPrice: lmsrResult.avgPrice,
        priceBefore,
        priceAfter,
        slippage,
        priceImpact,
        deltas: {
          cashChanges: new Map([[intent.traderId, cashDelta]]),
          yesShareChanges: new Map([[intent.traderId, outcome === "YES" ? shareDelta : new Decimal(0)]]),
          noShareChanges: new Map([[intent.traderId, outcome === "NO" ? shareDelta : new Decimal(0)]]),
          ordersAdded: [],
          ordersRemoved: [],
          ordersModified: [],
        },
        marketState: this.getMarketState(),
        logs: this.collectLogs(intent, lmsrResult),
        timestamp,
      };
    } catch (e) {
      return this.createRejectedResult(intent, stateBefore, `${e}`);
    }
  }

  getMarketState(): MarketStateSnapshot {
    const prices = this.engine.getPrices(this.ledger.market);
    return {
      timestamp: Date.now(),
      engineType: this.engineType,
      priceYes: prices.pYES,
      priceNo: prices.pNO,
      midPrice: prices.pYES,
      qYes: this.ledger.market.qYes,
      qNo: this.ledger.market.qNo,
    };
  }

  getTraderState(traderId: string): TraderState | null {
    const trader = this.ledger.traders.get(traderId);
    const stats = this.traderStats.get(traderId);
    if (!trader || !stats) return null;

    return {
      traderId,
      cash: trader.cash,
      yesShares: trader.yesShares,
      noShares: trader.noShares,
      openOrders: 0, // LMSR doesn't have order book
      totalTrades: stats.trades,
      totalVolume: stats.volume,
      totalValue: stats.value,
    };
  }

  getAllTraderStates(): Map<string, TraderState> {
    const map = new Map<string, TraderState>();
    for (const [id] of this.ledger.traders.keys()) {
      const state = this.getTraderState(id);
      if (state) map.set(id, state);
    }
    return map;
  }

  reset(): void {
    this.initialize();
  }

  getMidPrice(): Decimal | null {
    const prices = this.engine.getPrices(this.ledger.market);
    return prices.pYES;
  }

  getBestBid(): Decimal | null {
    // LMSR doesn't have bids - return null
    return null;
  }

  getBestAsk(): Decimal | null {
    // LMSR doesn't have asks - return null
    return null;
  }

  getSpread(): Decimal | null {
    // LMSR doesn't have spread
    return null;
  }

  getDepth(): Decimal {
    // LMSR doesn't have depth
    return new Decimal(0);
  }

  cancelOrder(): ExecutionResult | null {
    // LMSR doesn't have cancellable orders
    return null;
  }

  getLogs(): readonly LogEntry[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private collectLogs(intent: OrderIntent, result: LMSRExecutionResult): LogEntry[] {
    const logs: LogEntry[] = [];

    logs.push({
      type: "ORDER_RECEIVED",
      timestamp: intent.timestamp,
      engineType: this.engineType,
      data: intent,
    });

    logs.push({
      type: "ORDER_FILLED",
      timestamp: Date.now(),
      engineType: this.engineType,
      data: result,
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
// Export factory functions
// ============================================================================

export function createEngine(type: string, config: EngineConfig): UnifiedEngine {
  switch (type) {
    case "CLOB":
      return new CLOBEngineAdapter(config);
    case "LMSR":
      return new LMSREngineAdapter(config);
    default:
      throw new Error(`Unknown engine type: ${type}`);
  }
}

// Re-export hybrid router v2 functions and types
export {
  createHybridEngineV2 as createHybridEngine,
  createHybridConfig,
  HybridRouterV2,
  createSpreadBasedConfig,
} from "./hybrid-router-v2";
export type { HybridConfigV2 as HybridConfig } from "./hybrid-router-v2";
