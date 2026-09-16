/**
 * CLOB (Central Limit Order Book) Engine - Pure deterministic order book matching
 *
 * Complete implementation with:
 * - Limit orders, Market orders, Cancel orders
 * - Multi-level matching with price-time priority (FIFO at each price level)
 * - O(1) best bid/ask retrieval via price level management
 * - Market data: best bid/ask, spread, mid-price, depth within N ticks
 * - Crossed orders execute immediately (marketable limit orders)
 * - Structured logging (ORDER_PLACED, ORDER_CANCELLED, TRADE, BOOK_SNAPSHOT, MARKET_DATA)
 * - Ledger integration with trader accounts
 */

import { Decimal } from "decimal.js";

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -28,
  toExpPos: 28,
});

// ============================================================================
// Core Types
// ============================================================================

export type Side = "BUY" | "SELL";

export type OrderStatus = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";

export type OrderType = "LIMIT" | "MARKET" | "CANCEL";

export interface PriceLevel {
  price: Decimal;
  side: Side;
  totalQty: Decimal;
  orders: LimitOrder[];
  prev?: PriceLevel;
  next?: PriceLevel;
}

export interface LimitOrder {
  orderId: string;
  traderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  originalQty: Decimal;
  timestamp: number;
  status: OrderStatus;
}

export interface MarketOrder {
  orderId: string;
  traderId: string;
  side: Side;
  qty: Decimal;
  timestamp: number;
  status: OrderStatus;
}

export interface Trade {
  tradeId: string;
  askOrderId: string;
  bidOrderId: string;
  price: Decimal;
  qty: Decimal;
  bidTraderId: string;
  askTraderId: string;
  timestamp: string;
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  trades: Trade[];
  filledQty: Decimal;
  remainingQty: Decimal;
  avgFillPrice: Decimal;
  timestamp: string;
}

export interface OrderBook {
  bids: Map<string, PriceLevel>;
  asks: Map<string, PriceLevel>;
  bestBid?: PriceLevel;
  bestAsk?: PriceLevel;
}

export interface CLOBMarketState {
  orderBook: OrderBook;
  lastTradePrice?: Decimal;
  tradeIdCounter: number;
  orderIdCounter: number;
  settled: boolean;
}

export interface TraderAccount {
  traderId: string;
  cash: Decimal;
  yesShares: Decimal;
  noShares: Decimal;
  openOrders: Set<string>;
}

export interface CLOBLedger {
  market: CLOBMarketState;
  traders: Map<string, TraderAccount>;
}

export type CLOBLogEntry =
  | { type: "ORDER_PLACED"; data: { order: LimitOrder | MarketOrder; timestamp: string } }
  | { type: "ORDER_CANCELLED"; data: { orderId: string; timestamp: string } }
  | { type: "TRADE"; data: Trade }
  | { type: "BOOK_SNAPSHOT"; data: { bids: PriceLevelSnapshot[]; asks: PriceLevelSnapshot[]; timestamp: string } }
  | { type: "MARKET_DATA"; data: { bestBid?: Decimal; bestAsk?: Decimal; spread?: Decimal; midPrice?: Decimal; timestamp: string } };

export interface PriceLevelSnapshot {
  price: Decimal;
  totalQty: Decimal;
  orderCount: number;
}

// ============================================================================
// CLOB Logger
// ============================================================================

export class CLOBLogger {
  private logs: CLOBLogEntry[] = [];

  logOrderPlaced(order: LimitOrder | MarketOrder): void {
    const timestamp = new Date().toISOString();
    this.logs.push({ type: "ORDER_PLACED", data: { order, timestamp } });
  }

  logOrderCancelled(orderId: string): void {
    const timestamp = new Date().toISOString();
    this.logs.push({ type: "ORDER_CANCELLED", data: { orderId, timestamp } });
  }

  logTrade(trade: Trade): void {
    this.logs.push({ type: "TRADE", data: trade });
  }

  logBookSnapshot(book: OrderBook): void {
    const timestamp = new Date().toISOString();
    const bids = this._snapshotLevels(book.bids, book.bestBid);
    const asks = this._snapshotLevels(book.asks, book.bestAsk);
    this.logs.push({ type: "BOOK_SNAPSHOT", data: { bids, asks, timestamp } });
  }

  logMarketData(book: OrderBook): void {
    const timestamp = new Date().toISOString();
    const bestBid = book.bestBid?.price;
    const bestAsk = book.bestAsk?.price;
    let spread: Decimal | undefined;
    let midPrice: Decimal | undefined;

    if (bestBid && bestAsk) {
      spread = bestAsk.minus(bestBid);
      midPrice = bestBid.plus(bestAsk).div(2);
    }

    this.logs.push({
      type: "MARKET_DATA",
      data: { bestBid, bestAsk, spread, midPrice, timestamp },
    });
  }

  private _snapshotLevels(
    levels: Map<string, PriceLevel>,
    start?: PriceLevel
  ): PriceLevelSnapshot[] {
    const snapshots: PriceLevelSnapshot[] = [];
    let current = start;
    while (current) {
      snapshots.push({
        price: current.price,
        totalQty: current.totalQty,
        orderCount: current.orders.length,
      });
      current = current.next;
    }
    return snapshots;
  }

  getLogs(): readonly CLOBLogEntry[] {
    return this.logs;
  }

  exportJson(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  clear(): void {
    this.logs = [];
  }
}

// ============================================================================
// CLOB Engine
// ============================================================================

export class CLOBEngine {
  private orderIdCounter: number = 0;
  private tradeIdCounter: number = 0;
  private readonly logger: CLOBLogger;

  constructor(logger?: CLOBLogger) {
    this.logger = logger ?? new CLOBLogger();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  initMarket(): CLOBMarketState {
    return {
      orderBook: {
        bids: new Map(),
        asks: new Map(),
      },
      tradeIdCounter: 0,
      orderIdCounter: 0,
      settled: false,
    };
  }

  initTrader(traderId: string, initialCash: number | Decimal): TraderAccount {
    return {
      traderId,
      cash: initialCash instanceof Decimal ? initialCash : new Decimal(initialCash),
      yesShares: new Decimal(0),
      noShares: new Decimal(0),
      openOrders: new Set(),
    };
  }

  initLedger(traders: Array<{ id: string; cash: number | Decimal }>): CLOBLedger {
    const market = this.initMarket();
    const traderMap = new Map<string, TraderAccount>();
    for (const t of traders) {
      traderMap.set(t.id, this.initTrader(t.id, t.cash));
    }
    return { market, traders: traderMap };
  }

  // -------------------------------------------------------------------------
  // Market Data
  // -------------------------------------------------------------------------

  getBestBid(book: OrderBook): Decimal | undefined {
    return book.bestBid?.price;
  }

  getBestAsk(book: OrderBook): Decimal | undefined {
    return book.bestAsk?.price;
  }

  getSpread(book: OrderBook): Decimal | undefined {
    const bestBid = this.getBestBid(book);
    const bestAsk = this.getBestAsk(book);
    if (bestBid && bestAsk) {
      return bestAsk.minus(bestBid);
    }
    return undefined;
  }

  getMidPrice(book: OrderBook): Decimal | undefined {
    const bestBid = this.getBestBid(book);
    const bestAsk = this.getBestAsk(book);
    if (bestBid && bestAsk) {
      return bestBid.plus(bestAsk).div(2);
    }
    return undefined;
  }

  getDepth(book: OrderBook, side: Side, ticks: number): Decimal {
    // Returns the depth of orders on this side (bids for BUY, asks for SELL)
    let start = side === "BUY" ? book.bestBid : book.bestAsk;
    let totalDepth = new Decimal(0);
    let count = 0;

    while (start && count < ticks) {
      totalDepth = totalDepth.plus(start.totalQty);
      start = start.next;
      count++;
    }

    return totalDepth;
  }

  /**
   * Get the depth of liquidity available to trade against (opposite side)
   * For BUY orders, returns ask depth (orders to buy into)
   * For SELL orders, returns bid depth (orders to sell into)
   */
  getLiquidityDepth(book: OrderBook, side: Side, ticks: number): Decimal {
    // For BUY, we want ask depth (liquidity to buy into)
    // For SELL, we want bid depth (liquidity to sell into)
    let start = side === "BUY" ? book.bestAsk : book.bestBid;
    let totalDepth = new Decimal(0);
    let count = 0;

    while (start && count < ticks) {
      totalDepth = totalDepth.plus(start.totalQty);
      start = start.next;
      count++;
    }

    return totalDepth;
  }

  getOrdersAtPrice(book: OrderBook, side: Side, price: Decimal): LimitOrder[] {
    const levels = side === "BUY" ? book.bids : book.asks;
    const priceKey = price.toString();
    const level = levels.get(priceKey);
    return level ? [...level.orders] : [];
  }

  // -------------------------------------------------------------------------
  // Order Operations
  // -------------------------------------------------------------------------

  placeLimitOrder(
    ledger: CLOBLedger,
    traderId: string,
    side: Side,
    price: number | Decimal,
    qty: number | Decimal
  ): OrderResult {
    if (ledger.market.settled) {
      throw new Error("Cannot trade in settled market");
    }

    const trader = ledger.traders.get(traderId);
    if (!trader) {
      throw new Error(`Trader ${traderId} not found`);
    }

    const priceD = price instanceof Decimal ? price : new Decimal(price);
    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);

    if (qtyD.lte(0)) {
      throw new Error("Quantity must be positive");
    }

    if (priceD.lte(0)) {
      throw new Error("Price must be positive");
    }

    const orderId = this._generateOrderId(ledger.market);
    const timestamp = Date.now();

    const order: LimitOrder = {
      orderId,
      traderId,
      side,
      price: priceD,
      qty: qtyD,
      originalQty: qtyD,
      timestamp,
      status: "OPEN",
    };

    this.logger.logOrderPlaced(order);

    let result: OrderResult;
    if (side === "BUY") {
      result = this._matchLimitBuy(ledger, order, traderId);
    } else {
      result = this._matchLimitSell(ledger, order, traderId);
    }

    return result;
  }

  placeMarketOrder(
    ledger: CLOBLedger,
    traderId: string,
    side: Side,
    qty: number | Decimal
  ): OrderResult {
    if (ledger.market.settled) {
      throw new Error("Cannot trade in settled market");
    }

    const trader = ledger.traders.get(traderId);
    if (!trader) {
      throw new Error(`Trader ${traderId} not found`);
    }

    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);

    if (qtyD.lte(0)) {
      throw new Error("Quantity must be positive");
    }

    const orderId = this._generateOrderId(ledger.market);
    const timestamp = Date.now();

    const order: MarketOrder = {
      orderId,
      traderId,
      side,
      qty: qtyD,
      timestamp,
      status: "OPEN",
    };

    this.logger.logOrderPlaced(order);

    let result: OrderResult;
    if (side === "BUY") {
      result = this._matchMarketBuy(ledger, qtyD, traderId);
    } else {
      result = this._matchMarketSell(ledger, qtyD, traderId);
    }

    return result;
  }

  cancelOrder(ledger: CLOBLedger, orderId: string): OrderResult {
    if (ledger.market.settled) {
      throw new Error("Cannot cancel orders in settled market");
    }

    const book = ledger.market.orderBook;
    const removedOrder = this._removeFromBook(book, orderId);

    if (!removedOrder) {
      return {
        orderId,
        status: "CANCELLED",
        trades: [],
        filledQty: new Decimal(0),
        remainingQty: new Decimal(0),
        avgFillPrice: new Decimal(0),
        timestamp: new Date().toISOString(),
      };
    }

    const trader = ledger.traders.get(removedOrder.traderId);
    if (trader) {
      trader.openOrders.delete(orderId);
    }

    this.logger.logOrderCancelled(orderId);

    return {
      orderId,
      status: "CANCELLED",
      trades: [],
      filledQty: removedOrder.originalQty.minus(removedOrder.qty),
      remainingQty: removedOrder.qty,
      avgFillPrice: new Decimal(0),
      timestamp: new Date().toISOString(),
    };
  }

  getOpenOrders(ledger: CLOBLedger, traderId: string): LimitOrder[] {
    const trader = ledger.traders.get(traderId);
    if (!trader) {
      return [];
    }

    const orders: LimitOrder[] = [];
    const book = ledger.market.orderBook;

    // Use the trader's openOrders set for efficient lookup
    for (const orderId of trader.openOrders) {
      // Search in bids
      for (const [priceKey, level] of book.bids) {
        for (const order of level.orders) {
          if (order.orderId === orderId) {
            orders.push(order);
            break;
          }
        }
      }
      // Search in asks
      for (const [priceKey, level] of book.asks) {
        for (const order of level.orders) {
          if (order.orderId === orderId) {
            orders.push(order);
            break;
          }
        }
      }
    }

    return orders;
  }

  // -------------------------------------------------------------------------
  // Private Matching Engine
  // -------------------------------------------------------------------------

  private _matchLimitBuy(ledger: CLOBLedger, order: LimitOrder, incomingTraderId: string): OrderResult {
    const book = ledger.market.orderBook;
    const trades: Trade[] = [];
    let remainingQty = order.qty;
    let totalFillPrice = new Decimal(0);
    let filledQty = new Decimal(0);
    const trader = ledger.traders.get(incomingTraderId)!;

    // Check if order is marketable (crosses the spread)
    const bestAsk = this.getBestAsk(book);
    if (bestAsk && order.price.gte(bestAsk)) {
      const crossResult = this._crossSpread(ledger, "BUY", remainingQty, incomingTraderId);
      trades.push(...crossResult.trades);

      for (const t of trades) {
        filledQty = filledQty.plus(t.qty);
        totalFillPrice = totalFillPrice.plus(t.price.times(t.qty));
      }

      remainingQty = crossResult.remainingQty;
    }

    // Determine final status
    let status: OrderStatus;
    if (remainingQty.eq(0)) {
      status = "FILLED";
    } else if (filledQty.gt(0)) {
      status = "PARTIALLY_FILLED";
    } else {
      status = "OPEN";
    }

    // If any quantity remains, add to book
    if (remainingQty.gt(0)) {
      const restingOrder: LimitOrder = {
        ...order,
        qty: remainingQty,
        status,
      };
      this._addToBook(book, restingOrder);
      trader.openOrders.add(order.orderId);
    }

    const avgFillPrice = filledQty.gt(0) ? totalFillPrice.div(filledQty) : new Decimal(0);

    return {
      orderId: order.orderId,
      status,
      trades,
      filledQty,
      remainingQty,
      avgFillPrice,
      timestamp: new Date().toISOString(),
    };
  }

  private _matchLimitSell(ledger: CLOBLedger, order: LimitOrder, incomingTraderId: string): OrderResult {
    const book = ledger.market.orderBook;
    const trades: Trade[] = [];
    let remainingQty = order.qty;
    let totalFillPrice = new Decimal(0);
    let filledQty = new Decimal(0);
    const trader = ledger.traders.get(incomingTraderId)!;

    // ===== SELL-TO-CLOSE VALIDATION =====
    // In prediction markets, you can only sell shares you own (no naked short selling).
    // To express a bearish view on YES, traders should BUY NO instead of SELL YES.
    // The adapter layer handles the NO/YES conversion for short-equivalent orders.

    // Calculate how many shares this trader has in open sell orders
    let openSellQty = new Decimal(0);
    for (const [, level] of ledger.market.orderBook.asks) {
      for (const o of level.orders) {
        if (o.traderId === incomingTraderId) {
          openSellQty = openSellQty.plus(o.qty);
        }
      }
    }

    // Available shares = current holdings - open sell orders
    const availableShares = trader.yesShares.minus(openSellQty);

    // Reject if trying to sell more than available
    if (order.qty.gt(availableShares)) {
      return {
        orderId: order.orderId,
        status: "CANCELLED",
        trades: [],
        filledQty: new Decimal(0),
        remainingQty: order.qty,
        avgFillPrice: new Decimal(0),
        timestamp: new Date().toISOString(),
      };
    }
    // ===== END SELL-TO-CLOSE VALIDATION =====

    // Check if order is marketable (crosses the spread)
    const bestBid = this.getBestBid(book);
    if (bestBid && order.price.lte(bestBid)) {
      const crossResult = this._crossSpread(ledger, "SELL", remainingQty, incomingTraderId);
      trades.push(...crossResult.trades);

      for (const t of trades) {
        filledQty = filledQty.plus(t.qty);
        totalFillPrice = totalFillPrice.plus(t.price.times(t.qty));
      }

      remainingQty = crossResult.remainingQty;
    }

    // Determine final status
    let status: OrderStatus;
    if (remainingQty.eq(0)) {
      status = "FILLED";
    } else if (filledQty.gt(0)) {
      status = "PARTIALLY_FILLED";
    } else {
      status = "OPEN";
    }

    // If any quantity remains, add to book
    if (remainingQty.gt(0)) {
      const restingOrder: LimitOrder = {
        ...order,
        qty: remainingQty,
        status,
      };
      this._addToBook(book, restingOrder);
      trader.openOrders.add(order.orderId);
    }

    const avgFillPrice = filledQty.gt(0) ? totalFillPrice.div(filledQty) : new Decimal(0);

    return {
      orderId: order.orderId,
      status,
      trades,
      filledQty,
      remainingQty,
      avgFillPrice,
      timestamp: new Date().toISOString(),
    };
  }

  private _matchMarketBuy(ledger: CLOBLedger, qty: Decimal, incomingTraderId: string): OrderResult {
    const book = ledger.market.orderBook;
    const trades: Trade[] = [];
    let remainingQty = qty;
    let totalFillPrice = new Decimal(0);
    let filledQty = new Decimal(0);

    // Check if there are any asks
    if (book.bestAsk) {
      const crossResult = this._crossSpread(ledger, "BUY", remainingQty, incomingTraderId);
      trades.push(...crossResult.trades);

      for (const t of trades) {
        filledQty = filledQty.plus(t.qty);
        totalFillPrice = totalFillPrice.plus(t.price.times(t.qty));
      }

      remainingQty = crossResult.remainingQty;
    }

    const status = remainingQty.eq(0) ? "FILLED" : "PARTIALLY_FILLED";
    const avgFillPrice = filledQty.gt(0) ? totalFillPrice.div(filledQty) : new Decimal(0);

    const orderId = `MKT-${Date.now()}`;

    return {
      orderId,
      status,
      trades,
      filledQty,
      remainingQty,
      avgFillPrice,
      timestamp: new Date().toISOString(),
    };
  }

  private _matchMarketSell(ledger: CLOBLedger, qty: Decimal, incomingTraderId: string): OrderResult {
    const book = ledger.market.orderBook;
    const trades: Trade[] = [];
    let remainingQty = qty;
    let totalFillPrice = new Decimal(0);
    let filledQty = new Decimal(0);

    // ===== SELL-TO-CLOSE VALIDATION =====
    // In prediction markets, you can only sell shares you own (no naked short selling).
    const trader = ledger.traders.get(incomingTraderId)!;
    if (qty.gt(trader.yesShares)) {
      throw new Error(`Insufficient shares for market sell. Have: ${trader.yesShares}, Trying to sell: ${qty}`);
    }
    // ===== END SELL-TO-CLOSE VALIDATION =====

    // Check if there are any bids
    if (book.bestBid) {
      const crossResult = this._crossSpread(ledger, "SELL", remainingQty, incomingTraderId);
      trades.push(...crossResult.trades);

      for (const t of trades) {
        filledQty = filledQty.plus(t.qty);
        totalFillPrice = totalFillPrice.plus(t.price.times(t.qty));
      }

      remainingQty = crossResult.remainingQty;
    }

    const status = remainingQty.eq(0) ? "FILLED" : "PARTIALLY_FILLED";
    const avgFillPrice = filledQty.gt(0) ? totalFillPrice.div(filledQty) : new Decimal(0);

    const orderId = `MKT-${Date.now()}`;

    return {
      orderId,
      status,
      trades,
      filledQty,
      remainingQty,
      avgFillPrice,
      timestamp: new Date().toISOString(),
    };
  }

  private _crossSpread(
    ledger: CLOBLedger,
    side: Side,
    qty: Decimal,
    incomingTraderId: string
  ): { trades: Trade[]; remainingQty: Decimal } {
    const trades: Trade[] = [];
    let remainingQty = qty;

    if (side === "BUY") {
      let askLevel = ledger.market.orderBook.bestAsk;
      while (askLevel && remainingQty.gt(0)) {
        let takenFromLevel = new Decimal(0);

        for (const askOrder of askLevel.orders) {
          if (remainingQty.lte(0)) break;

          const qtyToTakeFromOrder = Decimal.min(remainingQty, askOrder.qty);
          if (qtyToTakeFromOrder.gt(0)) {
            const trade = this._createTrade(ledger, askOrder, qtyToTakeFromOrder, askLevel.price, incomingTraderId, "BUY");
            trades.push(trade);
            this.logger.logTrade(trade);

            askOrder.qty = askOrder.qty.minus(qtyToTakeFromOrder);
            if (askOrder.qty.eq(0)) {
              askOrder.status = "FILLED";
              const askTrader = ledger.traders.get(askOrder.traderId);
              if (askTrader) {
                askTrader.openOrders.delete(askOrder.orderId);
              }
            } else {
              askOrder.status = "PARTIALLY_FILLED";
            }

            const askTrader = ledger.traders.get(askOrder.traderId);
            if (askTrader) {
              askTrader.cash = askTrader.cash.plus(qtyToTakeFromOrder.times(askLevel.price));
              askTrader.yesShares = askTrader.yesShares.minus(qtyToTakeFromOrder);
            }

            const incomingTrader = ledger.traders.get(incomingTraderId);
            if (incomingTrader) {
              incomingTrader.yesShares = incomingTrader.yesShares.plus(qtyToTakeFromOrder);
              incomingTrader.cash = incomingTrader.cash.minus(qtyToTakeFromOrder.times(askLevel.price));
            }

            remainingQty = remainingQty.minus(qtyToTakeFromOrder);
            takenFromLevel = takenFromLevel.plus(qtyToTakeFromOrder);
          }
        }

        askLevel.totalQty = askLevel.totalQty.minus(takenFromLevel);
        askLevel.orders = askLevel.orders.filter(o => o.qty.gt(0));

        if (askLevel.totalQty.lte(0) || askLevel.orders.length === 0) {
          const priceKey = askLevel.price.toString();
          ledger.market.orderBook.asks.delete(priceKey);
          ledger.market.orderBook.bestAsk = askLevel.next;
          if (askLevel.next) {
            askLevel.next.prev = undefined;
          }
        }

        askLevel = ledger.market.orderBook.bestAsk;
      }
    } else {
      let bidLevel = ledger.market.orderBook.bestBid;
      while (bidLevel && remainingQty.gt(0)) {
        let takenFromLevel = new Decimal(0);

        for (const bidOrder of bidLevel.orders) {
          if (remainingQty.lte(0)) break;

          const qtyToTakeFromOrder = Decimal.min(remainingQty, bidOrder.qty);
          if (qtyToTakeFromOrder.gt(0)) {
            const trade = this._createTrade(ledger, bidOrder, qtyToTakeFromOrder, bidLevel.price, incomingTraderId, "SELL");
            trades.push(trade);
            this.logger.logTrade(trade);

            bidOrder.qty = bidOrder.qty.minus(qtyToTakeFromOrder);
            if (bidOrder.qty.eq(0)) {
              bidOrder.status = "FILLED";
              const bidTrader = ledger.traders.get(bidOrder.traderId);
              if (bidTrader) {
                bidTrader.openOrders.delete(bidOrder.orderId);
              }
            } else {
              bidOrder.status = "PARTIALLY_FILLED";
            }

            const bidTrader = ledger.traders.get(bidOrder.traderId);
            if (bidTrader) {
              bidTrader.yesShares = bidTrader.yesShares.plus(qtyToTakeFromOrder);
              bidTrader.cash = bidTrader.cash.minus(qtyToTakeFromOrder.times(bidLevel.price));
            }

            const incomingTrader = ledger.traders.get(incomingTraderId);
            if (incomingTrader) {
              incomingTrader.cash = incomingTrader.cash.plus(qtyToTakeFromOrder.times(bidLevel.price));
              incomingTrader.yesShares = incomingTrader.yesShares.minus(qtyToTakeFromOrder);
            }

            remainingQty = remainingQty.minus(qtyToTakeFromOrder);
            takenFromLevel = takenFromLevel.plus(qtyToTakeFromOrder);
          }
        }

        bidLevel.totalQty = bidLevel.totalQty.minus(takenFromLevel);
        bidLevel.orders = bidLevel.orders.filter(o => o.qty.gt(0));

        if (bidLevel.totalQty.lte(0) || bidLevel.orders.length === 0) {
          const priceKey = bidLevel.price.toString();
          ledger.market.orderBook.bids.delete(priceKey);
          ledger.market.orderBook.bestBid = bidLevel.next;
          if (bidLevel.next) {
            bidLevel.next.prev = undefined;
          }
        }

        bidLevel = ledger.market.orderBook.bestBid;
      }
    }

    if (trades.length > 0) {
      const lastTrade = trades[trades.length - 1];
      ledger.market.lastTradePrice = lastTrade.price;
    }

    return { trades, remainingQty };
  }

  private _createTrade(
    ledger: CLOBLedger,
    restingOrder: LimitOrder,
    qty: Decimal,
    price: Decimal,
    incomingTraderId: string,
    incomingSide: Side
  ): Trade {
    ledger.market.tradeIdCounter++;
    const tradeId = `TRD-${ledger.market.tradeIdCounter.toString().padStart(8, "0")}`;
    const timestamp = new Date().toISOString();

    if (incomingSide === "BUY") {
      return {
        tradeId,
        askOrderId: restingOrder.orderId,
        bidOrderId: incomingTraderId,
        price,
        qty,
        bidTraderId: incomingTraderId,
        askTraderId: restingOrder.traderId,
        timestamp,
      };
    } else {
      return {
        tradeId,
        askOrderId: incomingTraderId,
        bidOrderId: restingOrder.orderId,
        price,
        qty,
        bidTraderId: restingOrder.traderId,
        askTraderId: incomingTraderId,
        timestamp,
      };
    }
  }

  private _addToBook(book: OrderBook, order: LimitOrder): void {
    const levels = order.side === "BUY" ? book.bids : book.asks;
    const priceKey = order.price.toString();

    let level = levels.get(priceKey);
    if (!level) {
      level = {
        price: order.price,
        side: order.side,
        totalQty: new Decimal(0),
        orders: [],
      };
      levels.set(priceKey, level);
      this._insertLevelInOrder(book, level);
    }

    level.orders.push(order);
    level.totalQty = level.totalQty.plus(order.qty);
  }

  private _removeFromBook(book: OrderBook, orderId: string): LimitOrder | undefined {
    for (const [priceKey, level] of book.bids) {
      const orderIndex = level.orders.findIndex(o => o.orderId === orderId);
      if (orderIndex !== -1) {
        const order = level.orders[orderIndex];
        level.orders.splice(orderIndex, 1);
        level.totalQty = level.totalQty.minus(order.qty);

        if (level.orders.length === 0) {
          book.bids.delete(priceKey);
          this._updatePriceLevelPointers(book);
        }

        return order;
      }
    }

    for (const [priceKey, level] of book.asks) {
      const orderIndex = level.orders.findIndex(o => o.orderId === orderId);
      if (orderIndex !== -1) {
        const order = level.orders[orderIndex];
        level.orders.splice(orderIndex, 1);
        level.totalQty = level.totalQty.minus(order.qty);

        if (level.orders.length === 0) {
          book.asks.delete(priceKey);
          this._updatePriceLevelPointers(book);
        }

        return order;
      }
    }

    return undefined;
  }

  private _insertLevelInOrder(book: OrderBook, newLevel: PriceLevel): void {
    if (newLevel.side === "BUY") {
      let current = book.bestBid;
      let prev: PriceLevel | undefined;

      while (current && current.price.gt(newLevel.price)) {
        prev = current;
        current = current.next;
      }

      if (prev) {
        newLevel.next = prev.next;
        newLevel.prev = prev;
        prev.next = newLevel;
        if (newLevel.next) {
          newLevel.next.prev = newLevel;
        }
      } else {
        newLevel.next = book.bestBid;
        if (book.bestBid) {
          book.bestBid.prev = newLevel;
        }
        book.bestBid = newLevel;
      }
    } else {
      let current = book.bestAsk;
      let prev: PriceLevel | undefined;

      while (current && current.price.lt(newLevel.price)) {
        prev = current;
        current = current.next;
      }

      if (prev) {
        newLevel.next = prev.next;
        newLevel.prev = prev;
        prev.next = newLevel;
        if (newLevel.next) {
          newLevel.next.prev = newLevel;
        }
      } else {
        newLevel.next = book.bestAsk;
        if (book.bestAsk) {
          book.bestAsk.prev = newLevel;
        }
        book.bestAsk = newLevel;
      }
    }

    this._updatePriceLevelPointers(book);
  }

  private _updatePriceLevelPointers(book: OrderBook): void {
    if (book.bids.size > 0) {
      const bidPrices = Array.from(book.bids.keys()).map(p => new Decimal(p));
      bidPrices.sort((a, b) => b.minus(a).toNumber());
      const bestBidPrice = bidPrices[0].toString();
      book.bestBid = book.bids.get(bestBidPrice);
      this._rebuildLinkedList(book, "BUY");
    } else {
      book.bestBid = undefined;
    }

    if (book.asks.size > 0) {
      const askPrices = Array.from(book.asks.keys()).map(p => new Decimal(p));
      askPrices.sort((a, b) => a.minus(b).toNumber());
      const bestAskPrice = askPrices[0].toString();
      book.bestAsk = book.asks.get(bestAskPrice);
      this._rebuildLinkedList(book, "SELL");
    } else {
      book.bestAsk = undefined;
    }
  }

  private _rebuildLinkedList(book: OrderBook, side: Side): void {
    const levels = side === "BUY" ? book.bids : book.asks;

    if (side === "BUY") {
      const prices = Array.from(levels.keys()).map(p => new Decimal(p));
      prices.sort((a, b) => b.minus(a).toNumber());

      let prev: PriceLevel | undefined;
      for (const price of prices) {
        const level = levels.get(price.toString())!;
        level.prev = prev;
        level.next = undefined;
        if (prev) {
          prev.next = level;
        }
        prev = level;
      }
    } else {
      const prices = Array.from(levels.keys()).map(p => new Decimal(p));
      prices.sort((a, b) => a.minus(b).toNumber());

      let prev: PriceLevel | undefined;
      for (const price of prices) {
        const level = levels.get(price.toString())!;
        level.prev = prev;
        level.next = undefined;
        if (prev) {
          prev.next = level;
        }
        prev = level;
      }
    }
  }

  private _generateOrderId(market: CLOBMarketState): string {
    market.orderIdCounter++;
    return `ORD-${market.orderIdCounter.toString().padStart(8, "0")}`;
  }

  getLogger(): CLOBLogger {
    return this.logger;
  }
}

export const clob = new CLOBEngine();

export function applyTrade(ledger: CLOBLedger, result: OrderResult, incomingTraderId: string): CLOBLedger {
  const trader = ledger.traders.get(incomingTraderId);
  if (!trader) {
    throw new Error(`Trader ${incomingTraderId} not found`);
  }

  for (const trade of result.trades) {
    if (trade.bidTraderId === incomingTraderId) {
      trader.cash = trader.cash.minus(trade.price.times(trade.qty));
      trader.yesShares = trader.yesShares.plus(trade.qty);
    } else if (trade.askTraderId === incomingTraderId) {
      trader.cash = trader.cash.plus(trade.price.times(trade.qty));
      trader.yesShares = trader.yesShares.minus(trade.qty);
    }
  }

  if (trader.cash.lt(0)) {
    throw new Error("Cash would be negative after trade");
  }

  return ledger;
}
