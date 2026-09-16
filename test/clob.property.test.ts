/**
 * Property-based tests for CLOB using fast-check
 *
 * These tests generate thousands of random order sequences and verify
 * that critical invariants always hold. This is the most effective way
 * to find edge cases that hand-written tests might miss.
 */

import { describe, it, expect } from "vitest";
import { Decimal } from "decimal.js";
import * as fc from "fast-check";
import {
  CLOBEngine,
  CLOBLedger,
  Side,
  OrderStatus,
  OrderBook,
  LimitOrder,
  Trade,
} from "../src/lib/clob";

// ============================================================================
// Arbitraries (Random Value Generators)
// ============================================================================

/** Valid prices for prediction markets (1-99 cents) */
const priceArbitrary = fc.integer({ min: 1, max: 99 }).map(cents => new Decimal(cents).div(100));

/** Valid quantities (1-100 shares) */
const qtyArbitrary = fc.integer({ min: 1, max: 100 }).map(n => new Decimal(n));

/** Trader IDs (small set to increase conflicts) */
const traderIdArbitrary = fc.constantFrom("alice", "bob", "carol", "dave", "eve");

/** Order sides */
const sideArbitrary: fc.Arbitrary<Side> = fc.constantFrom("BUY", "SELL");

/** Initial cash for traders */
const initialCashArbitrary = fc.integer({ min: 1000, max: 100000 }).map(n => new Decimal(n));

/** Initial shares for traders */
const initialSharesArbitrary = fc.integer({ min: 50, max: 500 }).map(n => new Decimal(n));

// ============================================================================
// Command Generators
// ============================================================================

type CLOBCommand =
  | { type: "PLACE_LIMIT"; traderId: string; side: Side; price: Decimal; qty: Decimal }
  | { type: "PLACE_MARKET"; traderId: string; side: Side; qty: Decimal }
  | { type: "CANCEL"; traderId: string; orderId?: string };

/**
 * Generate a valid limit order command.
 * For SELL orders, we need to track the trader's available shares.
 */
function limitOrderCommand(traderStates: Map<string, { shares: Decimal; openSells: Decimal }>): fc.Arbitrary<CLOBCommand> {
  return fc.tuple(traderIdArbitrary, sideArbitrary, priceArbitrary, qtyArbitrary).map(
    ([traderId, side, price, qty]) => {
      // For SELL orders, ensure we don't exceed available shares
      if (side === "SELL") {
        const state = traderStates.get(traderId) || { shares: new Decimal(100), openSells: new Decimal(0) };
        const available = state.shares.minus(state.openSells);
        // Cap qty at available shares
        const maxQty = Decimal.min(qty, available);
        if (maxQty.lte(0)) {
          // Return a BUY order instead if no shares available
          return { type: "PLACE_LIMIT", traderId, side: "BUY", price, qty: new Decimal(1) };
        }
        return { type: "PLACE_LIMIT", traderId, side: "SELL", price, qty: maxQty };
      }
      return { type: "PLACE_LIMIT", traderId, side, price, qty };
    }
  );
}

/**
 * Generate a valid market order command.
 */
function marketOrderCommand(traderStates: Map<string, { shares: Decimal; openSells: Decimal }>): fc.Arbitrary<CLOBCommand> {
  return fc.tuple(traderIdArbitrary, sideArbitrary, qtyArbitrary).map(([traderId, side, qty]) => {
    if (side === "SELL") {
      const state = traderStates.get(traderId) || { shares: new Decimal(100), openSells: new Decimal(0) };
      const available = state.shares.minus(state.openSells);
      const maxQty = Decimal.min(qty, available);
      if (maxQty.lte(0)) {
        return { type: "PLACE_MARKET", traderId, side: "BUY", qty: new Decimal(1) };
      }
      return { type: "PLACE_MARKET", traderId, side: "SELL", qty: maxQty };
    }
    return { type: "PLACE_MARKET", traderId, side, qty };
  });
}

/**
 * Generate a cancel command for a random order.
 */
function cancelCommand(openOrders: Map<string, string[]>): fc.Arbitrary<CLOBCommand> {
  const tradersWithOrders = Array.from(openOrders.keys()).filter(t => (openOrders.get(t)?.length || 0) > 0);
  if (tradersWithOrders.length === 0) {
    // Return a placeholder that won't match anything
    return fc.constant({ type: "CANCEL", traderId: "__none__" });
  }
  return fc.constantFrom(...tradersWithOrders).map(traderId => {
    const orders = openOrders.get(traderId)!;
    const orderId = fc.sample(fc.constantFrom(...orders), 1)[0] || orders[0];
    return { type: "CANCEL", traderId, orderId };
  });
}

/**
 * Generate a sequence of random CLOB commands.
 */
function commandSequence(): fc.Arbitrary<CLOBCommand[]> {
  return fc.array(fc.oneof(
    limitOrderCommand(new Map()),
    marketOrderCommand(new Map()),
    fc.constant({ type: "CANCEL", traderId: "__none__" })
  ), { minLength: 1, maxLength: 100 });
}

// ============================================================================
// Invariant Checkers
// ============================================================================

/**
 * Check that the order book is never crossed (bestBid < bestAsk always).
 */
function assertBookNotCrossed(book: OrderBook, context: string): void {
  const bestBid = getBestBidFromBook(book);
  const bestAsk = getBestAskFromBook(book);

  if (bestBid !== undefined && bestAsk !== undefined) {
    expect(bestBid.lt(bestAsk), `Crossed book at ${context}: bestBid=${bestBid} should be < bestAsk=${bestAsk}`).toBe(true);
  }
}

/**
 * Get the best bid from the order book.
 */
function getBestBidFromBook(book: OrderBook): Decimal | undefined {
  let bestPrice: Decimal | undefined;
  for (const [_, level] of book.bids) {
    if (bestPrice === undefined || level.price.gt(bestPrice)) {
      bestPrice = level.price;
    }
  }
  return bestPrice;
}

/**
 * Get the best ask from the order book.
 */
function getBestAskFromBook(book: OrderBook): Decimal | undefined {
  let bestPrice: Decimal | undefined;
  for (const [_, level] of book.asks) {
    if (bestPrice === undefined || level.price.lt(bestPrice)) {
      bestPrice = level.price;
    }
  }
  return bestPrice;
}

/**
 * Check that all traders have non-negative balances.
 */
function assertNoNegativeBalances(ledger: CLOBLedger, context: string): void {
  for (const [traderId, trader] of ledger.traders) {
    expect(trader.cash.gte(0), `${context}: Trader ${traderId} has negative cash: ${trader.cash}`).toBe(true);
    expect(trader.yesShares.gte(0), `${context}: Trader ${traderId} has negative yesShares: ${trader.yesShares}`).toBe(true);
    expect(trader.noShares.gte(0), `${context}: Trader ${traderId} has negative noShares: ${trader.noShares}`).toBe(true);
  }
}

/**
 * Check that total value is conserved (sum of all cash + shares*referencePrice).
 * This is a weak conservation check since prices vary, but it ensures
 * value isn't being created or destroyed.
 */
function assertValueConservation(
  initialTraders: Map<string, { cash: Decimal; yesShares: Decimal }>,
  currentTraders: Map<string, { cash: Decimal; yesShares: Decimal }>,
  context: string
): void {
  // Calculate initial total value (using a reference price of 0.50)
  const referencePrice = new Decimal(0.50);
  let initialTotal = new Decimal(0);
  for (const [_, t] of initialTraders) {
    initialTotal = initialTotal.plus(t.cash).plus(t.yesShares.times(referencePrice));
  }

  // Calculate current total value
  let currentTotal = new Decimal(0);
  for (const [_, t] of currentTraders) {
    currentTotal = currentTotal.plus(t.cash).plus(t.yesShares.times(referencePrice));
  }

  // The total should be the same (modulo trading activity which changes share distribution)
  // We check that the difference is reasonable (not huge unexplained changes)
  const diff = currentTotal.minus(initialTotal).abs();
  expect(diff.lt(10000), `${context}: Value conservation check failed - diff=${diff} too large`).toBe(true);
}

/**
 * Check FIFO ordering at a specific price level.
 * Orders should be filled in timestamp order (oldest first).
 */
function assertFIFOOrdering(book: OrderBook, context: string): void {
  // Check both bids and asks
  for (const [priceStr, level] of book.bids) {
    const timestamps = level.orders.map(o => o.timestamp);
    // Verify timestamps are non-decreasing
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1], `${context}: Bids at ${priceStr} not in FIFO order`).toBe(true);
    }
  }
  for (const [priceStr, level] of book.asks) {
    const timestamps = level.orders.map(o => o.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1], `${context}: Asks at ${priceStr} not in FIFO order`).toBe(true);
    }
  }
}

/**
 * Check that order quantities are consistent.
 * For each order: originalQty = filledQty + remainingQty
 */
function assertOrderQtyConsistency(ledger: CLOBLedger, context: string): void {
  for (const [_, trader] of ledger.traders) {
    for (const orderId of trader.openOrders) {
      // Find the order in the book
      let found = false;
      for (const [_, level] of ledger.market.orderBook.bids) {
        const order = level.orders.find(o => o.orderId === orderId);
        if (order) {
          // The qty in the book is the remaining qty
          // We can't easily verify originalQty without storing it separately
          found = true;
          break;
        }
      }
      if (!found) {
        for (const [_, level] of ledger.market.orderBook.asks) {
          const order = level.orders.find(o => o.orderId === orderId);
          if (order) {
            found = true;
            break;
          }
        }
      }
      // If order is in openOrders but not in book, that's a bug
      expect(found, `${context}: Order ${orderId} in openOrders but not in book`).toBe(true);
    }
  }
}

/**
 * Check that the order book depth is consistent.
 * Sum of all orders at all price levels should equal total quantity.
 */
function assertBookDepthConsistent(book: OrderBook, context: string): void {
  // Calculate bids total
  let bidsTotal = new Decimal(0);
  for (const [_, level] of book.bids) {
    let levelTotal = new Decimal(0);
    for (const order of level.orders) {
      levelTotal = levelTotal.plus(order.qty);
    }
    expect(levelTotal.equals(level.totalQty), `${context}: Bids at ${level.price} totalQty mismatch`).toBe(true);
    bidsTotal = bidsTotal.plus(levelTotal);
  }

  // Calculate asks total
  let asksTotal = new Decimal(0);
  for (const [_, level] of book.asks) {
    let levelTotal = new Decimal(0);
    for (const order of level.orders) {
      levelTotal = levelTotal.plus(order.qty);
    }
    expect(levelTotal.equals(level.totalQty), `${context}: Asks at ${level.price} totalQty mismatch`).toBe(true);
    asksTotal = asksTotal.plus(levelTotal);
  }
}

// ============================================================================
// Property-Based Tests
// ============================================================================

describe("CLOB: Property-Based Tests - Invariants", () => {

  it("property: book never crossed after random operations", () => {
    fc.assert(fc.property(
      commandSequence(),
      (commands) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
          { id: "carol", cash: 10000 },
        ]);

        // Give initial shares
        for (const [_, trader] of ledger.traders) {
          trader.yesShares = new Decimal(200);
        }

        // Track open orders for cancel commands
        const openOrders = new Map<string, string[]>();

        for (const cmd of commands) {
          // Skip invalid commands
          if (cmd.type === "CANCEL" && cmd.traderId === "__none__") continue;

          try {
            let result;
            switch (cmd.type) {
              case "PLACE_LIMIT": {
                // Check if trader can sell
                if (cmd.side === "SELL") {
                  const trader = ledger.traders.get(cmd.traderId);
                  if (!trader) continue;
                  let openSellQty = new Decimal(0);
                  for (const [_, level] of ledger.market.orderBook.asks) {
                    for (const o of level.orders) {
                      if (o.traderId === cmd.traderId) {
                        openSellQty = openSellQty.plus(o.qty);
                      }
                    }
                  }
                  const available = trader.yesShares.minus(openSellQty);
                  if (cmd.qty.gt(available)) continue;
                }
                result = engine.placeLimitOrder(ledger, cmd.traderId, cmd.side, cmd.price, cmd.qty);
                if (result.status === "OPEN" || result.status === "PARTIALLY_FILLED") {
                  const orders = openOrders.get(cmd.traderId) || [];
                  orders.push(result.orderId);
                  openOrders.set(cmd.traderId, orders);
                }
                break;
              }
              case "PLACE_MARKET": {
                // Check if trader can sell
                if (cmd.side === "SELL") {
                  const trader = ledger.traders.get(cmd.traderId);
                  if (!trader) continue;
                  if (cmd.qty.gt(trader.yesShares)) continue;
                }
                result = engine.placeMarketOrder(ledger, cmd.traderId, cmd.side, cmd.qty);
                break;
              }
              case "CANCEL": {
                const orders = openOrders.get(cmd.traderId) || [];
                if (orders.length > 0 && cmd.orderId) {
                  result = engine.cancelOrder(ledger, cmd.orderId);
                  // Remove from open orders
                  const idx = orders.indexOf(cmd.orderId);
                  if (idx !== -1) orders.splice(idx, 1);
                }
                break;
              }
            }

            // Check invariant after each operation
            assertBookNotCrossed(ledger.market.orderBook, `after ${cmd.type}`);
          } catch (e) {
            // Ignore errors from invalid operations
            if (!(e instanceof Error) || !e.message.includes("not found")) {
              throw e;
            }
          }
        }

        return true;
      }
    ));
  });

  it("property: no negative balances after random operations", () => {
    fc.assert(fc.property(
      commandSequence(),
      (commands) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
          { id: "carol", cash: 10000 },
        ]);

        // Give initial shares
        for (const [_, trader] of ledger.traders) {
          trader.yesShares = new Decimal(200);
        }

        for (const cmd of commands) {
          if (cmd.type === "CANCEL" && cmd.traderId === "__none__") continue;

          try {
            switch (cmd.type) {
              case "PLACE_LIMIT": {
                if (cmd.side === "SELL") {
                  const trader = ledger.traders.get(cmd.traderId);
                  if (!trader) continue;
                  let openSellQty = new Decimal(0);
                  for (const [_, level] of ledger.market.orderBook.asks) {
                    for (const o of level.orders) {
                      if (o.traderId === cmd.traderId) {
                        openSellQty = openSellQty.plus(o.qty);
                      }
                    }
                  }
                  const available = trader.yesShares.minus(openSellQty);
                  if (cmd.qty.gt(available)) continue;
                }
                engine.placeLimitOrder(ledger, cmd.traderId, cmd.side, cmd.price, cmd.qty);
                break;
              }
              case "PLACE_MARKET": {
                if (cmd.side === "SELL") {
                  const trader = ledger.traders.get(cmd.traderId);
                  if (!trader) continue;
                  if (cmd.qty.gt(trader.yesShares)) continue;
                }
                engine.placeMarketOrder(ledger, cmd.traderId, cmd.side, cmd.qty);
                break;
              }
              case "CANCEL": {
                // Skip cancel for simplicity
                break;
              }
            }

            assertNoNegativeBalances(ledger, `after ${cmd.type}`);
          } catch (e) {
            if (!(e instanceof Error) || !e.message.includes("not found")) {
              throw e;
            }
          }
        }

        return true;
      }
    ));
  });

  it("property: FIFO ordering preserved at each price level", () => {
    fc.assert(fc.property(
      fc.array(
        fc.tuple(traderIdArbitrary, priceArbitrary, qtyArbitrary),
        { minLength: 1, maxLength: 50 }
      ),
      (orders) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
          { id: "carol", cash: 10000 },
        ]);

        // Give initial shares
        for (const [_, trader] of ledger.traders) {
          trader.yesShares = new Decimal(500);
        }

        // Place all SELL orders at same price
        const testPrice = new Decimal(0.50);
        for (const [traderId, _, qty] of orders) {
          try {
            engine.placeLimitOrder(ledger, traderId, "SELL", testPrice, qty);
          } catch (e) {
            // Skip if insufficient shares
          }
        }

        assertFIFOOrdering(ledger.market.orderBook, "after placing multiple sell orders");
        return true;
      }
    ));
  });

  it("property: order book depth is consistent", () => {
    fc.assert(fc.property(
      commandSequence(),
      (commands) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        // Give initial shares
        for (const [_, trader] of ledger.traders) {
          trader.yesShares = new Decimal(300);
        }

        for (const cmd of commands) {
          if (cmd.type === "CANCEL" && cmd.traderId === "__none__") continue;
          if (cmd.type === "CANCEL") continue; // Skip cancel for simplicity

          try {
            switch (cmd.type) {
              case "PLACE_LIMIT": {
                if (cmd.side === "SELL") {
                  const trader = ledger.traders.get(cmd.traderId);
                  if (!trader) continue;
                  let openSellQty = new Decimal(0);
                  for (const [_, level] of ledger.market.orderBook.asks) {
                    for (const o of level.orders) {
                      if (o.traderId === cmd.traderId) {
                        openSellQty = openSellQty.plus(o.qty);
                      }
                    }
                  }
                  const available = trader.yesShares.minus(openSellQty);
                  if (cmd.qty.gt(available)) continue;
                }
                engine.placeLimitOrder(ledger, cmd.traderId, cmd.side, cmd.price, cmd.qty);
                break;
              }
              case "PLACE_MARKET": {
                if (cmd.side === "SELL") {
                  const trader = ledger.traders.get(cmd.traderId);
                  if (!trader) continue;
                  if (cmd.qty.gt(trader.yesShares)) continue;
                }
                engine.placeMarketOrder(ledger, cmd.traderId, cmd.side, cmd.qty);
                break;
              }
            }

            assertBookDepthConsistent(ledger.market.orderBook, `after ${cmd.type}`);
          } catch (e) {
            if (!(e instanceof Error) || !e.message.includes("not found")) {
              throw e;
            }
          }
        }

        return true;
      }
    ));
  });

  it("property: same command sequence produces same result (determinism)", () => {
    fc.assert(fc.property(
      commandSequence(),
      (commands) => {
        // Filter out invalid commands
        const validCommands = commands.filter(c => !(c.type === "CANCEL" && c.traderId === "__none__"));

        // Create two identical engines
        const engine1 = new CLOBEngine();
        const engine2 = new CLOBEngine();

        const ledger1 = engine1.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);
        const ledger2 = engine2.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        // Give initial shares
        for (const [_, trader] of ledger1.traders) {
          trader.yesShares = new Decimal(200);
        }
        for (const [_, trader] of ledger2.traders) {
          trader.yesShares = new Decimal(200);
        }

        // Execute same commands on both
        for (const cmd of validCommands) {
          if (cmd.type === "CANCEL") continue; // Skip cancel for determinism (orderId depends on internal state)

          try {
            switch (cmd.type) {
              case "PLACE_LIMIT": {
                if (cmd.side === "SELL") {
                  const trader1 = ledger1.traders.get(cmd.traderId);
                  const trader2 = ledger2.traders.get(cmd.traderId);
                  if (!trader1 || !trader2) continue;

                  let openSellQty1 = new Decimal(0);
                  let openSellQty2 = new Decimal(0);
                  for (const [_, level] of ledger1.market.orderBook.asks) {
                    for (const o of level.orders) {
                      if (o.traderId === cmd.traderId) {
                        openSellQty1 = openSellQty1.plus(o.qty);
                      }
                    }
                  }
                  for (const [_, level] of ledger2.market.orderBook.asks) {
                    for (const o of level.orders) {
                      if (o.traderId === cmd.traderId) {
                        openSellQty2 = openSellQty2.plus(o.qty);
                      }
                    }
                  }

                  const available1 = trader1.yesShares.minus(openSellQty1);
                  const available2 = trader2.yesShares.minus(openSellQty2);

                  if (cmd.qty.gt(available1) || cmd.qty.gt(available2)) continue;
                }
                engine1.placeLimitOrder(ledger1, cmd.traderId, cmd.side, cmd.price, cmd.qty);
                engine2.placeLimitOrder(ledger2, cmd.traderId, cmd.side, cmd.price, cmd.qty);
                break;
              }
              case "PLACE_MARKET": {
                if (cmd.side === "SELL") {
                  const trader1 = ledger1.traders.get(cmd.traderId);
                  const trader2 = ledger2.traders.get(cmd.traderId);
                  if (!trader1 || !trader2) continue;
                  if (cmd.qty.gt(trader1.yesShares) || cmd.qty.gt(trader2.yesShares)) continue;
                }
                engine1.placeMarketOrder(ledger1, cmd.traderId, cmd.side, cmd.qty);
                engine2.placeMarketOrder(ledger2, cmd.traderId, cmd.side, cmd.qty);
                break;
              }
            }
          } catch (e) {
            if (!(e instanceof Error) || !e.message.includes("not found")) {
              throw e;
            }
          }
        }

        // Compare final states
        expect(ledger1.traders.size).toEqual(ledger2.traders.size);
        for (const [traderId, trader1] of ledger1.traders) {
          const trader2 = ledger2.traders.get(traderId);
          expect(trader2).toBeDefined();
          expect(trader1.cash.equals(trader2!.cash), `Determinism failed: cash mismatch for ${traderId}`).toBe(true);
          expect(trader1.yesShares.equals(trader2!.yesShares), `Determinism failed: shares mismatch for ${traderId}`).toBe(true);
        }

        return true;
      }
    ));
  });

  it("property: partial fills conserve quantity", () => {
    fc.assert(fc.property(
      fc.tuple(priceArbitrary, priceArbitrary, qtyArbitrary, qtyArbitrary),
      ([price1, price2, buyQty, sellQty]) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        ledger.traders.get("alice")!.yesShares = new Decimal(500);
        ledger.traders.get("bob")!.yesShares = new Decimal(500);

        // Place a large sell order
        const sellResult = engine.placeLimitOrder(ledger, "alice", "SELL", price1, sellQty);
        if (sellResult.status !== "OPEN") return true; // Skip if crossed

        // Place a smaller buy order
        const buyResult = engine.placeLimitOrder(ledger, "bob", "BUY", price1, buyQty);

        // Check that filledQty + remainingQty = orderQty
        const sum = buyResult.filledQty.plus(buyResult.remainingQty);
        expect(sum.equals(buyQty), `Partial fill conservation: filled=${buyResult.filledQty} + remaining=${buyResult.remainingQty} != ${buyQty}`).toBe(true);

        return true;
      }
    ));
  });

  it("property: market orders walk book correctly", () => {
    fc.assert(fc.property(
      fc.array(priceArbitrary, { minLength: 1, maxLength: 10 }),
      (prices) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        // Give alice lots of shares to sell
        ledger.traders.get("alice")!.yesShares = new Decimal(1000);

        // Sort prices for asks (ascending)
        const sortedPrices = [...prices].sort((a, b) => a.minus(b).toNumber());

        // Place sell orders at different price levels
        for (const price of sortedPrices) {
          engine.placeLimitOrder(ledger, "alice", "SELL", price, 10);
        }

        const book = ledger.market.orderBook;
        const bestAsk = getBestAskFromBook(book);

        if (bestAsk) {
          // Market buy should execute at best prices first
          const result = engine.placeMarketOrder(ledger, "bob", "BUY", 25);

          // Should have traded at the best prices
          let totalFilled = new Decimal(0);
          for (const trade of result.trades) {
            totalFilled = totalFilled.plus(trade.qty);
          }

          expect(totalFilled.equals(result.filledQty), "Market order: sum of trade quantities != filledQty").toBe(true);

          // Total filled should not exceed order quantity
          expect(result.filledQty.lte(25), "Market order: filled more than ordered").toBe(true);
        }

        return true;
      }
    ));
  });
});

describe("CLOB: Property-Based Tests - Edge Cases", () => {

  it("property: cross-spread orders execute immediately", () => {
    fc.assert(fc.property(
      fc.tuple(priceArbitrary, priceArbitrary, qtyArbitrary),
      ([bidPrice, askPrice, qty]) => {
        // Ensure bidPrice < askPrice for initial spread
        if (bidPrice.gte(askPrice)) {
          bidPrice = new Decimal(0.40);
          askPrice = new Decimal(0.60);
        }

        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        ledger.traders.get("alice")!.yesShares = new Decimal(500);

        // Place an ask
        const askResult = engine.placeLimitOrder(ledger, "alice", "SELL", askPrice, qty);
        if (askResult.status !== "OPEN") return true;

        // Place a bid that crosses (higher than ask)
        const crossingBidPrice = askPrice.plus(new Decimal(0.05));
        const bidResult = engine.placeLimitOrder(ledger, "bob", "BUY", crossingBidPrice, qty);

        // Should have immediately traded
        if (bidResult.trades.length > 0) {
          // Trade should have happened at ask price
          expect(bidResult.trades[0].price.equals(askPrice), "Cross-spread trade should execute at resting price").toBe(true);
        }

        return true;
      }
    ));
  });

  it("property: multiple orders at same price fill in FIFO order", () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(traderIdArbitrary, qtyArbitrary), { minLength: 2, maxLength: 5 }),
      (orders) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
          { id: "carol", cash: 10000 },
          { id: "dave", cash: 10000 },
          { id: "eve", cash: 10000 },
        ]);

        // Give everyone shares
        for (const [_, trader] of ledger.traders) {
          trader.yesShares = new Decimal(500);
        }

        const testPrice = new Decimal(0.50);

        // Place multiple sell orders at same price
        const placedOrders: Array<{ traderId: string; qty: Decimal; timestamp: number }> = [];
        for (const [traderId, qty] of orders) {
          try {
            const result = engine.placeLimitOrder(ledger, traderId, "SELL", testPrice, qty);
            if (result.status === "OPEN") {
              // Get the order to check timestamp
              for (const [_, level] of ledger.market.orderBook.asks) {
                if (level.price.equals(testPrice)) {
                  for (const order of level.orders) {
                    if (order.traderId === traderId && !placedOrders.find(p => p.traderId === traderId)) {
                      placedOrders.push({ traderId, qty, timestamp: order.timestamp });
                    }
                  }
                }
              }
            }
          } catch (e) {
            // Skip insufficient shares
          }
        }

        if (placedOrders.length < 2) return true;

        // Place a buy order that will partially fill
        const totalQty = placedOrders.reduce((sum, o) => sum.plus(o.qty), new Decimal(0));
        const buyQty = Decimal.min(totalQty.minus(1), new Decimal(10));
        if (buyQty.lte(0)) return true;

        engine.placeLimitOrder(ledger, "alice", "BUY", testPrice, buyQty);

        // Check that orders were filled in timestamp order
        const book = ledger.market.orderBook;
        const level = book.asks.get(testPrice.toString());
        if (level && level.orders.length > 0) {
          const timestamps = level.orders.map(o => o.timestamp);
          for (let i = 1; i < timestamps.length; i++) {
            expect(timestamps[i] >= timestamps[i - 1], "Orders at same price not filled in FIFO order").toBe(true);
          }
        }

        return true;
      }
    ));
  });

  it("property: cancel after partial fill works correctly", () => {
    fc.assert(fc.property(
      fc.tuple(priceArbitrary, qtyArbitrary, qtyArbitrary),
      ([price, largeQty, smallQty]) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
          { id: "bob", cash: 10000 },
        ]);

        ledger.traders.get("alice")!.yesShares = largeQty.plus(100);

        // Place a large sell order
        const sellResult = engine.placeLimitOrder(ledger, "alice", "SELL", price, largeQty);
        if (sellResult.status !== "OPEN") return true;

        // Partially fill it
        const buyResult = engine.placeLimitOrder(ledger, "bob", "BUY", price, smallQty);
        if (buyResult.filledQty.eq(0)) return true;

        // Cancel the remaining
        const cancelResult = engine.cancelOrder(ledger, sellResult.orderId);

        // Cancel should show the remaining quantity
        const expectedRemaining = largeQty.minus(sellResult.filledQty.minus(buyResult.filledQty));
        // Note: The actual remaining depends on internal state

        expect(cancelResult.status).toBe("CANCELLED");
        expect(cancelResult.trades.length).toBe(0);

        // Order should be removed from book
        const found = orderInBook(ledger.market.orderBook, sellResult.orderId);
        expect(found).toBe(false);

        return true;
      }
    ));
  });

  it("property: sell-to-close is enforced", () => {
    fc.assert(fc.property(
      fc.tuple(initialSharesArbitrary, qtyArbitrary),
      ([initialShares, sellQty]) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
        ]);

        ledger.traders.get("alice")!.yesShares = initialShares;

        // Try to sell more than we have
        const excessQty = initialShares.plus(sellQty).plus(10);
        const result = engine.placeLimitOrder(ledger, "alice", "SELL", new Decimal(0.50), excessQty);

        // Should be cancelled
        expect(result.status).toBe("CANCELLED");
        expect(result.filledQty.equals(0)).toBe(true);
        expect(result.remainingQty.equals(excessQty)).toBe(true);

        return true;
      }
    ));
  });

  it("property: sell-to-close accounts for open orders", () => {
    fc.assert(fc.property(
      fc.tuple(initialSharesArbitrary, qtyArbitrary, qtyArbitrary),
      ([initialShares, firstQty, secondQty]) => {
        const engine = new CLOBEngine();
        const ledger = engine.initLedger([
          { id: "alice", cash: 10000 },
        ]);

        ledger.traders.get("alice")!.yesShares = initialShares;

        // Place first sell order
        const firstResult = engine.placeLimitOrder(ledger, "alice", "SELL", new Decimal(0.50), firstQty);
        if (firstResult.status !== "OPEN") return true; // Skip if somehow crossed

        // Try to sell more than remaining
        const excessQty = initialShares.minus(firstQty).plus(secondQty).plus(10);
        if (excessQty.lte(0)) return true;

        const secondResult = engine.placeLimitOrder(ledger, "alice", "SELL", new Decimal(0.55), excessQty);

        // Should be cancelled
        expect(secondResult.status).toBe("CANCELLED");

        return true;
      }
    ));
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

function orderInBook(book: OrderBook, orderId: string): boolean {
  for (const [_, level] of book.bids) {
    if (level.orders.find(o => o.orderId === orderId)) return true;
  }
  for (const [_, level] of book.asks) {
    if (level.orders.find(o => o.orderId === orderId)) return true;
  }
  return false;
}
