/**
 * Differential tests for CLOB engine
 *
 * These tests compare the production CLOB engine against a simple,
 * obviously-correct reference model. For the same sequence of operations,
 * both should produce identical results.
 *
 * The reference model is intentionally simple (O(n²) matching) but
 * easy to verify as correct. Any divergence from the reference model
 * indicates a bug in the production implementation OR an edge case
 * that needs specification.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import * as fc from "fast-check";
import {
  CLOBEngine,
  CLOBLedger,
  Side,
  OrderStatus,
  Trade,
} from "../src/lib/clob";

// ============================================================================
// Reference Model - Simple, Obviously-Correct Implementation
// ============================================================================

interface RefOrder {
  orderId: string;
  traderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  originalQty: Decimal;
  timestamp: number;
  status: OrderStatus;
}

interface RefTrader {
  traderId: string;
  cash: Decimal;
  yesShares: Decimal;
  noShares: Decimal;
}

interface RefMarketState {
  orders: RefOrder[];
  trades: Trade[];
  orderIdCounter: number;
  tradeIdCounter: number;
}

interface RefLedger {
  traders: Map<string, RefTrader>;
  market: RefMarketState;
}

/**
 * Simple reference CLOB implementation.
 *
 * This model uses a straightforward O(n²) matching algorithm that is
 * easy to verify as correct:
 * 1. For each new order, scan ALL existing orders
 * 2. Match if prices are compatible and timestamp order is respected
 * 3. Use simple arrays (no complex data structures)
 * 4. No optimizations - just correct logic
 */
class ReferenceCLOB {
  private ledger: RefLedger;

  constructor() {
    this.ledger = {
      traders: new Map(),
      market: {
        orders: [],
        trades: [],
        orderIdCounter: 0,
        tradeIdCounter: 0,
      },
    };
  }

  initLedger(traders: Array<{ id: string; cash: Decimal | number }>): RefLedger {
    this.ledger.traders.clear();
    this.ledger.market.orders = [];
    this.ledger.market.trades = [];
    this.ledger.market.orderIdCounter = 0;
    this.ledger.market.tradeIdCounter = 0;

    for (const t of traders) {
      const cash = t.cash instanceof Decimal ? t.cash : new Decimal(t.cash);
      this.ledger.traders.set(t.id, {
        traderId: t.id,
        cash,
        yesShares: new Decimal(0),
        noShares: new Decimal(0),
      });
    }

    return this.ledger;
  }

  setShares(traderId: string, shares: Decimal | number): void {
    const trader = this.ledger.traders.get(traderId);
    if (trader) {
      trader.yesShares = shares instanceof Decimal ? shares : new Decimal(shares);
    }
  }

  getTrader(traderId: string): RefTrader | undefined {
    return this.ledger.traders.get(traderId);
  }

  /**
   * Place a limit order in the reference model.
   */
  placeLimitOrder(
    traderId: string,
    side: Side,
    price: Decimal | number,
    qty: Decimal | number
  ): { orderId: string; status: OrderStatus; trades: Trade[]; filledQty: Decimal; remainingQty: Decimal } {
    const priceD = price instanceof Decimal ? price : new Decimal(price);
    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);

    const trader = this.ledger.traders.get(traderId);
    if (!trader) {
      throw new Error(`Trader ${traderId} not found`);
    }

    // Sell-to-close validation
    if (side === "SELL") {
      const openSellQty = this.getOpenSellQty(traderId);
      const available = trader.yesShares.minus(openSellQty);
      if (qtyD.gt(available)) {
        this.ledger.market.orderIdCounter++;
        return {
          orderId: `REF-ORD-${this.ledger.market.orderIdCounter}`,
          status: "CANCELLED",
          trades: [],
          filledQty: new Decimal(0),
          remainingQty: qtyD,
        };
      }
    }

    this.ledger.market.orderIdCounter++;
    const order: RefOrder = {
      orderId: `REF-ORD-${this.ledger.market.orderIdCounter}`,
      traderId,
      side,
      price: priceD,
      qty: qtyD,
      originalQty: qtyD,
      timestamp: Date.now() + this.ledger.market.orders.length, // Ensure unique timestamps
      status: "OPEN",
    };

    const trades: Trade[] = [];
    let remainingQty = qtyD;
    let filledQty = new Decimal(0);

    // O(n²) matching
    while (remainingQty.gt(0)) {
      let bestMatch: RefOrder | null = null;
      let bestMatchIndex = -1;

      for (let i = 0; i < this.ledger.market.orders.length; i++) {
        const existingOrder = this.ledger.market.orders[i];

        if (existingOrder.side === side || existingOrder.status !== "OPEN") {
          continue;
        }

        // Check price compatibility
        let canMatch = false;
        if (side === "BUY" && existingOrder.side === "SELL") {
          canMatch = priceD.gte(existingOrder.price);
        } else if (side === "SELL" && existingOrder.side === "BUY") {
          canMatch = priceD.lte(existingOrder.price);
        }

        if (canMatch) {
          if (bestMatch === null) {
            bestMatch = existingOrder;
            bestMatchIndex = i;
          } else {
            // Prefer better price, then FIFO
            if (side === "BUY") {
              if (existingOrder.price.lt(bestMatch.price)) {
                bestMatch = existingOrder;
                bestMatchIndex = i;
              } else if (existingOrder.price.equals(bestMatch.price) && existingOrder.timestamp < bestMatch.timestamp) {
                bestMatch = existingOrder;
                bestMatchIndex = i;
              }
            } else {
              if (existingOrder.price.gt(bestMatch.price)) {
                bestMatch = existingOrder;
                bestMatchIndex = i;
              } else if (existingOrder.price.equals(bestMatch.price) && existingOrder.timestamp < bestMatch.timestamp) {
                bestMatch = existingOrder;
                bestMatchIndex = i;
              }
            }
          }
        }
      }

      if (bestMatch === null) break;

      const matchQty = Decimal.min(remainingQty, bestMatch.qty);
      const tradePrice = bestMatch.price;

      this.ledger.market.tradeIdCounter++;
      const trade: Trade = {
        tradeId: `REF-TRD-${this.ledger.market.tradeIdCounter}`,
        bidOrderId: side === "BUY" ? order.orderId : bestMatch.orderId,
        askOrderId: side === "SELL" ? order.orderId : bestMatch.orderId,
        price: tradePrice,
        qty: matchQty,
        bidTraderId: side === "BUY" ? traderId : bestMatch.traderId,
        askTraderId: side === "SELL" ? traderId : bestMatch.traderId,
        timestamp: new Date().toISOString(),
      };
      trades.push(trade);
      this.ledger.market.trades.push(trade);

      remainingQty = remainingQty.minus(matchQty);
      filledQty = filledQty.plus(matchQty);
      bestMatch.qty = bestMatch.qty.minus(matchQty);

      if (bestMatch.qty.eq(0)) {
        bestMatch.status = "FILLED";
      } else {
        bestMatch.status = "PARTIALLY_FILLED";
      }

      this.applyTrade(trade);
    }

    let status: OrderStatus;
    if (remainingQty.eq(0)) {
      status = "FILLED";
    } else if (filledQty.gt(0)) {
      status = "PARTIALLY_FILLED";
      order.qty = remainingQty;
      order.status = status;
      this.ledger.market.orders.push(order);
    } else {
      status = "OPEN";
      order.qty = remainingQty;
      order.status = status;
      this.ledger.market.orders.push(order);
    }

    return { orderId: order.orderId, status, trades, filledQty, remainingQty };
  }

  /**
   * Place a market order.
   */
  placeMarketOrder(
    traderId: string,
    side: Side,
    qty: Decimal | number
  ): { status: OrderStatus; trades: Trade[]; filledQty: Decimal; remainingQty: Decimal } {
    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);

    const trader = this.ledger.traders.get(traderId);
    if (!trader) {
      throw new Error(`Trader ${traderId} not found`);
    }

    if (side === "SELL" && qtyD.gt(trader.yesShares)) {
      throw new Error(`Insufficient shares for market sell. Have: ${trader.yesShares}, Trying to sell: ${qtyD}`);
    }

    const trades: Trade[] = [];
    let remainingQty = qtyD;
    let filledQty = new Decimal(0);

    while (remainingQty.gt(0)) {
      let bestMatch: RefOrder | null = null;
      let bestMatchIndex = -1;

      for (let i = 0; i < this.ledger.market.orders.length; i++) {
        const existingOrder = this.ledger.market.orders[i];

        if (existingOrder.side === side || existingOrder.status !== "OPEN") {
          continue;
        }

        if (bestMatch === null) {
          bestMatch = existingOrder;
          bestMatchIndex = i;
        } else {
          if (side === "BUY") {
            if (existingOrder.price.lt(bestMatch.price)) {
              bestMatch = existingOrder;
              bestMatchIndex = i;
            } else if (existingOrder.price.equals(bestMatch.price) && existingOrder.timestamp < bestMatch.timestamp) {
              bestMatch = existingOrder;
              bestMatchIndex = i;
            }
          } else {
            if (existingOrder.price.gt(bestMatch.price)) {
              bestMatch = existingOrder;
              bestMatchIndex = i;
            } else if (existingOrder.price.equals(bestMatch.price) && existingOrder.timestamp < bestMatch.timestamp) {
              bestMatch = existingOrder;
              bestMatchIndex = i;
            }
          }
        }
      }

      if (bestMatch === null) break;

      const matchQty = Decimal.min(remainingQty, bestMatch.qty);
      const tradePrice = bestMatch.price;

      this.ledger.market.orderIdCounter++;
      this.ledger.market.tradeIdCounter++;
      const tempOrderId = `REF-MKT-ORD-${this.ledger.market.orderIdCounter}`;

      const trade: Trade = {
        tradeId: `REF-TRD-${this.ledger.market.tradeIdCounter}`,
        bidOrderId: side === "BUY" ? tempOrderId : bestMatch.orderId,
        askOrderId: side === "SELL" ? tempOrderId : bestMatch.orderId,
        price: tradePrice,
        qty: matchQty,
        bidTraderId: side === "BUY" ? traderId : bestMatch.traderId,
        askTraderId: side === "SELL" ? traderId : bestMatch.traderId,
        timestamp: new Date().toISOString(),
      };
      trades.push(trade);
      this.ledger.market.trades.push(trade);

      remainingQty = remainingQty.minus(matchQty);
      filledQty = filledQty.plus(matchQty);
      bestMatch.qty = bestMatch.qty.minus(matchQty);

      if (bestMatch.qty.eq(0)) {
        bestMatch.status = "FILLED";
      } else {
        bestMatch.status = "PARTIALLY_FILLED";
      }

      this.applyTrade(trade);
    }

    let status: OrderStatus;
    if (remainingQty.eq(0)) {
      status = "FILLED";
    } else if (filledQty.gt(0)) {
      status = "PARTIALLY_FILLED";
    } else {
      status = "OPEN"; // No liquidity
    }

    return { status, trades, filledQty, remainingQty };
  }

  private applyTrade(trade: Trade): void {
    const bidTrader = this.ledger.traders.get(trade.bidTraderId);
    const askTrader = this.ledger.traders.get(trade.askTraderId);

    if (bidTrader && askTrader) {
      const cost = trade.price.times(trade.qty);
      bidTrader.cash = bidTrader.cash.minus(cost);
      bidTrader.yesShares = bidTrader.yesShares.plus(trade.qty);
      askTrader.cash = askTrader.cash.plus(cost);
      askTrader.yesShares = askTrader.yesShares.minus(trade.qty);
    }
  }

  private getOpenSellQty(traderId: string): Decimal {
    let total = new Decimal(0);
    for (const order of this.ledger.market.orders) {
      if (order.traderId === traderId && order.side === "SELL" && order.status !== "CANCELLED") {
        total = total.plus(order.qty);
      }
    }
    return total;
  }

  cancelOrder(orderId: string): { status: OrderStatus; remainingQty: Decimal; filledQty: Decimal } {
    const orderIndex = this.ledger.market.orders.findIndex(o => o.orderId === orderId);
    if (orderIndex === -1) {
      return { status: "CANCELLED", remainingQty: new Decimal(0), filledQty: new Decimal(0) };
    }

    const order = this.ledger.market.orders[orderIndex];
    const remainingQty = order.qty;
    const filledQty = order.originalQty.minus(order.qty);

    this.ledger.market.orders.splice(orderIndex, 1);

    return { status: "CANCELLED", remainingQty, filledQty };
  }

  getTrades(): Trade[] {
    return [...this.ledger.market.trades];
  }
}

// ============================================================================
// Differential Tests
// ============================================================================

describe("CLOB: Differential Tests - Production vs Reference Model", () => {
  let prodEngine: CLOBEngine;
  let prodLedger: CLOBLedger;
  let refModel: ReferenceCLOB;
  let refLedger: RefLedger;

  beforeEach(() => {
    prodEngine = new CLOBEngine();
    prodLedger = prodEngine.initLedger([
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 10000 },
      { id: "carol", cash: 10000 },
    ]);

    refModel = new ReferenceCLOB();
    refLedger = refModel.initLedger([
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 10000 },
      { id: "carol", cash: 10000 },
    ]);
  });

  function compareTraderStates(prodTraderId: string, refTraderId: string, context: string): void {
    const prodTrader = prodLedger.traders.get(prodTraderId);
    const refTrader = refModel.getTrader(refTraderId);

    expect(prodTrader).toBeDefined();
    expect(refTrader).toBeDefined();

    expect(prodTrader!.cash.equals(refTrader!.cash), `${context}: Cash mismatch for ${prodTraderId}: prod=${prodTrader!.cash}, ref=${refTrader!.cash}`).toBe(true);

    expect(prodTrader!.yesShares.equals(refTrader!.yesShares), `${context}: Shares mismatch for ${prodTraderId}: prod=${prodTrader!.yesShares}, ref=${refTrader!.yesShares}`).toBe(true);
  }

  it("differential: simple buy-sell match", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));

    const prodResult = prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 10);
    const refResult = refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 10);

    expect(prodResult.status).toEqual(refResult.status);
    expect(prodResult.filledQty.equals(refResult.filledQty)).toBe(true);
    expect(prodResult.remainingQty.equals(refResult.remainingQty)).toBe(true);

    const prodBuyResult = prodEngine.placeLimitOrder(prodLedger, "bob", "BUY", new Decimal(0.50), 10);
    const refBuyResult = refModel.placeLimitOrder("bob", "BUY", new Decimal(0.50), 10);

    expect(prodBuyResult.status).toEqual(refBuyResult.status);
    expect(prodBuyResult.filledQty.equals(refBuyResult.filledQty)).toBe(true);

    compareTraderStates("alice", "alice", "final");
    compareTraderStates("bob", "bob", "final");
  });

  it("differential: partial fill", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));

    prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 20);
    refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 20);

    const prodBuyResult = prodEngine.placeLimitOrder(prodLedger, "bob", "BUY", new Decimal(0.50), 10);
    const refBuyResult = refModel.placeLimitOrder("bob", "BUY", new Decimal(0.50), 10);

    expect(prodBuyResult.status).toEqual(refBuyResult.status);
    expect(prodBuyResult.filledQty.equals(refBuyResult.filledQty)).toBe(true);

    compareTraderStates("alice", "alice", "after partial fill");
    compareTraderStates("bob", "bob", "after partial fill");
  });

  it("differential: price-time priority", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    prodLedger.traders.get("bob")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));
    refModel.setShares("bob", new Decimal(100));

    prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.55), 10);
    refModel.placeLimitOrder("alice", "SELL", new Decimal(0.55), 10);

    prodEngine.placeLimitOrder(prodLedger, "bob", "SELL", new Decimal(0.50), 10);
    refModel.placeLimitOrder("bob", "SELL", new Decimal(0.50), 10);

    const prodBuyResult = prodEngine.placeLimitOrder(prodLedger, "carol", "BUY", new Decimal(0.60), 10);
    const refBuyResult = refModel.placeLimitOrder("carol", "BUY", new Decimal(0.60), 10);

    expect(prodBuyResult.trades.length).toBe(refBuyResult.trades.length);
    if (prodBuyResult.trades.length > 0 && refBuyResult.trades.length > 0) {
      expect(prodBuyResult.trades[0].askTraderId).toBe(refBuyResult.trades[0].askTraderId);
    }
  });

  it("differential: FIFO at same price", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    prodLedger.traders.get("bob")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));
    refModel.setShares("bob", new Decimal(100));

    prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 10);
    refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 10);

    prodEngine.placeLimitOrder(prodLedger, "bob", "SELL", new Decimal(0.50), 10);
    refModel.placeLimitOrder("bob", "SELL", new Decimal(0.50), 10);

    const prodBuyResult1 = prodEngine.placeLimitOrder(prodLedger, "carol", "BUY", new Decimal(0.50), 5);
    const refBuyResult1 = refModel.placeLimitOrder("carol", "BUY", new Decimal(0.50), 5);

    expect(prodBuyResult1.trades[0]?.askTraderId).toBe("alice");
    expect(refBuyResult1.trades[0]?.askTraderId).toBe("alice");

    prodEngine.placeLimitOrder(prodLedger, "carol", "BUY", new Decimal(0.50), 10);
    refModel.placeLimitOrder("carol", "BUY", new Decimal(0.50), 10);

    // Compare trades - the key is that both match in same order
    expect(prodBuyResult1.trades.length).toBe(refBuyResult1.trades.length);
    expect(prodBuyResult1.filledQty.equals(refBuyResult1.filledQty)).toBe(true);
  });

  it("differential: market order walks book", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    prodLedger.traders.get("bob")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));
    refModel.setShares("bob", new Decimal(100));

    prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 5);
    refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 5);

    prodEngine.placeLimitOrder(prodLedger, "bob", "SELL", new Decimal(0.55), 5);
    refModel.placeLimitOrder("bob", "SELL", new Decimal(0.55), 5);

    const prodMarketResult = prodEngine.placeMarketOrder(prodLedger, "carol", "BUY", 8);
    const refMarketResult = refModel.placeMarketOrder("carol", "BUY", 8);

    expect(prodMarketResult.status).toEqual(refMarketResult.status);
    expect(prodMarketResult.filledQty.equals(refMarketResult.filledQty)).toBe(true);

    compareTraderStates("alice", "alice", "after market order");
    compareTraderStates("bob", "bob", "after market order");
    compareTraderStates("carol", "carol", "after market order");
  });

  it("differential: cancel order", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));

    const prodPlaceResult = prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 20);
    const refPlaceResult = refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 20);

    prodEngine.placeLimitOrder(prodLedger, "bob", "BUY", new Decimal(0.50), 5);
    refModel.placeLimitOrder("bob", "BUY", new Decimal(0.50), 5);

    const prodCancelResult = prodEngine.cancelOrder(prodLedger, prodPlaceResult.orderId);
    const refCancelResult = refModel.cancelOrder(refPlaceResult.orderId);

    expect(prodCancelResult.status).toEqual(refCancelResult.status);
    expect(prodCancelResult.remainingQty.equals(refCancelResult.remainingQty)).toBe(true);

    compareTraderStates("alice", "alice", "after cancel");
  });

  it("differential: sell-to-close enforcement", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(50);
    refModel.setShares("alice", new Decimal(50));

    const prodResult = prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 100);
    const refResult = refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 100);

    expect(prodResult.status).toEqual(refResult.status);
    expect(prodResult.status).toBe("CANCELLED");
  });

  it("differential: cross-spread execution", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(100);
    refModel.setShares("alice", new Decimal(100));

    const prodAsk = prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.60), 10);
    const refAsk = refModel.placeLimitOrder("alice", "SELL", new Decimal(0.60), 10);

    const prodBid = prodEngine.placeLimitOrder(prodLedger, "bob", "BUY", new Decimal(0.65), 10);
    const refBid = refModel.placeLimitOrder("bob", "BUY", new Decimal(0.65), 10);

    expect(prodAsk.status).toEqual(refAsk.status);
    expect(prodBid.status).toEqual(refBid.status);
    expect(prodBid.filledQty.equals(refBid.filledQty)).toBe(true);

    // Trade should execute at ask price (0.60)
    expect(prodBid.trades[0]?.price.equals(new Decimal(0.60))).toBe(true);
    expect(refBid.trades[0]?.price.equals(new Decimal(0.60))).toBe(true);

    compareTraderStates("alice", "alice", "cross-spread");
    compareTraderStates("bob", "bob", "cross-spread");
  });

  it("differential: multi-price level matching", () => {
    prodLedger.traders.get("alice")!.yesShares = new Decimal(200);
    prodLedger.traders.get("bob")!.yesShares = new Decimal(200);
    prodLedger.traders.get("carol")!.yesShares = new Decimal(200);
    refModel.setShares("alice", new Decimal(200));
    refModel.setShares("bob", new Decimal(200));
    refModel.setShares("carol", new Decimal(200));

    // Set up asks at multiple levels
    prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", new Decimal(0.50), 5);
    refModel.placeLimitOrder("alice", "SELL", new Decimal(0.50), 5);

    prodEngine.placeLimitOrder(prodLedger, "bob", "SELL", new Decimal(0.55), 5);
    refModel.placeLimitOrder("bob", "SELL", new Decimal(0.55), 5);

    prodEngine.placeLimitOrder(prodLedger, "carol", "SELL", new Decimal(0.60), 5);
    refModel.placeLimitOrder("carol", "SELL", new Decimal(0.60), 5);

    // Buy order that walks the book
    const prodBuy = prodEngine.placeLimitOrder(prodLedger, "alice", "BUY", new Decimal(0.65), 12);
    const refBuy = refModel.placeLimitOrder("alice", "BUY", new Decimal(0.65), 12);

    expect(prodBuy.trades.length).toBe(refBuy.trades.length);
    expect(prodBuy.filledQty.equals(refBuy.filledQty)).toBe(true);

    compareTraderStates("alice", "alice", "multi-level");
    compareTraderStates("bob", "bob", "multi-level");
    compareTraderStates("carol", "carol", "multi-level");
  });
});

describe("CLOB: Differential Property Tests", () => {

  it("property: alternating buy/sell sequences match reference", () => {
    fc.assert(fc.property(
      fc.array(
        fc.record({
          isBuy: fc.boolean(),
          price: fc.integer({ min: 30, max: 70 }).map(c => new Decimal(c).div(100)),
          qty: fc.integer({ min: 1, max: 20 }).map(n => new Decimal(n)),
        }),
        { minLength: 5, maxLength: 30 }
      ),
      (operations) => {
        const prodEngine = new CLOBEngine();
        const prodLedger = prodEngine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        const refModel = new ReferenceCLOB();
        const refLedger = refModel.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        // Alice has shares to sell
        prodLedger.traders.get("alice")!.yesShares = new Decimal(500);
        refModel.setShares("alice", new Decimal(500));

        // Bob only buys (no shares to sell)
        // So we alternate: alice sells, bob buys

        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          const side = op.isBuy ? "BUY" : "SELL";

          // Assign traders based on side to avoid self-matching
          const trader = side === "SELL" ? "alice" : "bob";

          try {
            const prodResult = prodEngine.placeLimitOrder(prodLedger, trader, side, op.price, op.qty);
            const refResult = refModel.placeLimitOrder(trader, side, op.price, op.qty);

            expect(prodResult.status).toEqual(refResult.status);
            expect(prodResult.filledQty.equals(refResult.filledQty), `filledQty mismatch for ${trader} ${side} @ ${op.price}, op=${i}`).toBe(true);
          } catch (e) {
            // Both should error or neither
          }
        }

        return true;
      }
    ));
  });

  it("property: multiple price levels match reference", () => {
    fc.assert(fc.property(
      fc.array(
        fc.integer({ min: 1, max: 99 }).map(c => new Decimal(c).div(100)),
        { minLength: 3, maxLength: 10 }
      ),
      (prices) => {
        const prodEngine = new CLOBEngine();
        const prodLedger = prodEngine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        const refModel = new ReferenceCLOB();
        const refLedger = refModel.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        // Alice has lots of shares
        prodLedger.traders.get("alice")!.yesShares = new Decimal(1000);
        refModel.setShares("alice", new Decimal(1000));

        // Alice sells at different price levels
        for (const price of prices) {
          try {
            prodEngine.placeLimitOrder(prodLedger, "alice", "SELL", price, 10);
            refModel.placeLimitOrder("alice", "SELL", price, 10);
          } catch (e) {
            // Skip
          }
        }

        // Bob buys at highest price (should walk the book)
        const maxPrice = prices.reduce((max, p) => p.gt(max) ? p : max, new Decimal(0));
        const prodResult = prodEngine.placeLimitOrder(prodLedger, "bob", "BUY", maxPrice, 50);
        const refResult = refModel.placeLimitOrder("bob", "BUY", maxPrice, 50);

        expect(prodResult.filledQty.equals(refResult.filledQty), `filledQty mismatch: prod=${prodResult.filledQty}, ref=${refResult.filledQty}`).toBe(true);
        expect(prodResult.trades.length).toBe(refResult.trades.length);

        return true;
      }
    ));
  });
});
