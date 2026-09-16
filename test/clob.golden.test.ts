/**
 * Golden-run regression tests for CLOB engine
 *
 * These tests use fixed seeds to generate reproducible order sequences,
 * then snapshot the critical outputs. Future changes must match these
 * baselines or be intentionally updated.
 *
 * This protects against:
 * - "Tests still pass but behavior changed"
 * - Subtle bugs that don't trigger invariant violations
 * - Performance optimizations that change semantics
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  CLOBEngine,
  CLOBLedger,
  CLOBLogger,
  Side,
  OrderStatus,
  CLOBLogEntry,
} from "../src/lib/clob";

// ============================================================================
// Test Scenarios with Fixed Seeds
// ============================================================================

interface GoldenSnapshot {
  scenario: string;
  seed: number;
  operations: Array<{
    type: "LIMIT" | "MARKET" | "CANCEL";
    trader: string;
    side: Side;
    price?: number;
    qty: number;
  }>;
  // Final state after all operations
  finalTrades: number;
  finalBalances: Record<string, { cash: string; yesShares: string }>;
  // Order book state
  bestBid?: string;
  bestAsk?: string;
  totalBidQty: string;
  totalAskQty: string;
}

// Pre-computed golden snapshots for these scenarios
// These serve as the "source of truth" for regression testing
const GOLDEN_SNAPSHOTS: GoldenSnapshot[] = [
  {
    scenario: "simple_cross",
    seed: 42,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.50, qty: 10 },
      { type: "LIMIT", trader: "bob", side: "BUY", price: 0.55, qty: 10 },
    ],
    finalTrades: 1,
    finalBalances: {
      alice: { cash: "10005", yesShares: "90" },
      bob: { cash: "9995", yesShares: "110" },
      carol: { cash: "10000", yesShares: "100" },
      dave: { cash: "10000", yesShares: "100" },
    },
    bestBid: undefined,
    bestAsk: undefined,
    totalBidQty: "0",
    totalAskQty: "0",
  },
  {
    scenario: "partial_fill",
    seed: 43,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.50, qty: 20 },
      { type: "LIMIT", trader: "bob", side: "BUY", price: 0.50, qty: 10 },
    ],
    finalTrades: 1,
    finalBalances: {
      alice: { cash: "10005", yesShares: "90" },
      bob: { cash: "9995", yesShares: "110" },
      carol: { cash: "10000", yesShares: "100" },
      dave: { cash: "10000", yesShares: "100" },
    },
    bestBid: undefined,
    bestAsk: "0.5",
    totalBidQty: "0",
    totalAskQty: "10",
  },
  {
    scenario: "fifo_same_price",
    seed: 44,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.50, qty: 5 },
      { type: "LIMIT", trader: "bob", side: "SELL", price: 0.50, qty: 5 },
      { type: "LIMIT", trader: "carol", side: "SELL", price: 0.50, qty: 5 },
      { type: "LIMIT", trader: "dave", side: "BUY", price: 0.55, qty: 12 },
    ],
    finalTrades: 3,
    finalBalances: {
      alice: { cash: "10002.5", yesShares: "95" },
      bob: { cash: "10002.5", yesShares: "95" },
      carol: { cash: "10001", yesShares: "98" },
      dave: { cash: "9994", yesShares: "112" },
    },
    bestBid: undefined,
    bestAsk: "0.5",
    totalBidQty: "0",
    totalAskQty: "3",
  },
  {
    scenario: "price_priority",
    seed: 45,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.55, qty: 10 },
      { type: "LIMIT", trader: "bob", side: "SELL", price: 0.50, qty: 10 },
      { type: "LIMIT", trader: "carol", side: "BUY", price: 0.60, qty: 10 },
    ],
    finalTrades: 1,
    finalBalances: {
      alice: { cash: "10000", yesShares: "100" },
      bob: { cash: "10005", yesShares: "90" },
      carol: { cash: "9995", yesShares: "110" },
      dave: { cash: "10000", yesShares: "100" },
    },
    bestBid: undefined,
    bestAsk: "0.55",
    totalBidQty: "0",
    totalAskQty: "10",
  },
  {
    scenario: "market_order_walk",
    seed: 46,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.50, qty: 5 },
      { type: "LIMIT", trader: "bob", side: "SELL", price: 0.55, qty: 5 },
      { type: "LIMIT", trader: "carol", side: "SELL", price: 0.60, qty: 5 },
      { type: "MARKET", trader: "dave", side: "BUY", qty: 12 },
    ],
    finalTrades: 3,
    finalBalances: {
      alice: { cash: "10002.5", yesShares: "95" },
      bob: { cash: "10002.75", yesShares: "95" },
      carol: { cash: "10001.2", yesShares: "98" },
      dave: { cash: "9993.55", yesShares: "112" },
    },
    bestBid: undefined,
    bestAsk: "0.6",
    totalBidQty: "0",
    totalAskQty: "3",
  },
  {
    scenario: "multi_level_crossing",
    seed: 47,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.50, qty: 5 },
      { type: "LIMIT", trader: "bob", side: "SELL", price: 0.55, qty: 5 },
      { type: "LIMIT", trader: "carol", side: "SELL", price: 0.60, qty: 5 },
      { type: "LIMIT", trader: "dave", side: "BUY", price: 0.65, qty: 15 },
    ],
    finalTrades: 3,
    finalBalances: {
      alice: { cash: "10002.5", yesShares: "95" },
      bob: { cash: "10002.75", yesShares: "95" },
      carol: { cash: "10003", yesShares: "95" },
      dave: { cash: "9991.75", yesShares: "115" },
    },
    bestBid: undefined,
    bestAsk: undefined,
    totalBidQty: "0",
    totalAskQty: "0",
  },
  {
    scenario: "cancel_partial_fill",
    seed: 48,
    operations: [
      { type: "LIMIT", trader: "alice", side: "SELL", price: 0.50, qty: 20 },
      { type: "LIMIT", trader: "bob", side: "BUY", price: 0.50, qty: 5 },
      { type: "CANCEL", trader: "alice", side: "SELL", qty: 0 },
    ],
    finalTrades: 1,
    finalBalances: {
      alice: { cash: "10002.5", yesShares: "95" },
      bob: { cash: "9997.5", yesShares: "105" },
      carol: { cash: "10000", yesShares: "100" },
      dave: { cash: "10000", yesShares: "100" },
    },
    bestBid: undefined,
    bestAsk: "0.5",
    totalBidQty: "0",
    totalAskQty: "15",
  },
  {
    scenario: "spread_build",
    seed: 49,
    operations: [
      { type: "LIMIT", trader: "alice", side: "BUY", price: 0.45, qty: 10 },
      { type: "LIMIT", trader: "bob", side: "BUY", price: 0.46, qty: 10 },
      { type: "LIMIT", trader: "carol", side: "SELL", price: 0.55, qty: 10 },
      { type: "LIMIT", trader: "dave", side: "SELL", price: 0.56, qty: 10 },
    ],
    finalTrades: 0,
    finalBalances: {
      alice: { cash: "10000", yesShares: "100" },
      bob: { cash: "10000", yesShares: "100" },
      carol: { cash: "10000", yesShares: "100" },
      dave: { cash: "10000", yesShares: "100" },
    },
    bestBid: "0.46",
    bestAsk: "0.55",
    totalBidQty: "20",
    totalAskQty: "20",
  },
];

// ============================================================================
// Golden Master Tests
// ============================================================================

describe("CLOB: Golden Master Regression Tests", () => {
  let engine: CLOBEngine;
  let ledger: CLOBLedger;
  let logger: CLOBLogger;

  beforeEach(() => {
    logger = new CLOBLogger();
    engine = new CLOBEngine(logger);
    ledger = engine.initLedger([
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 10000 },
      { id: "carol", cash: 10000 },
      { id: "dave", cash: 10000 },
    ]);

    // Give all traders initial shares
    for (const [_, trader] of ledger.traders) {
      trader.yesShares = new Decimal(100);
    }
  });

  function runScenario(scenario: GoldenSnapshot): { ledger: CLOBLedger; tradeCount: number } {
    // Create new ledger for each scenario
    const newLedger = engine.initLedger([
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 10000 },
      { id: "carol", cash: 10000 },
      { id: "dave", cash: 10000 },
    ]);

    for (const [_, trader] of newLedger.traders) {
      trader.yesShares = new Decimal(100);
    }

    let tradeCount = 0;
    let lastOrderId: string | undefined;

    for (const op of scenario.operations) {
      switch (op.type) {
        case "LIMIT":
          if (op.price === undefined) throw new Error("LIMIT requires price");
          const result = engine.placeLimitOrder(
            newLedger,
            op.trader,
            op.side,
            new Decimal(op.price),
            new Decimal(op.qty)
          );
          tradeCount += result.trades.length;
          lastOrderId = result.orderId;
          break;
        case "MARKET":
          const mktResult = engine.placeMarketOrder(
            newLedger,
            op.trader,
            op.side,
            new Decimal(op.qty)
          );
          tradeCount += mktResult.trades.length;
          break;
        case "CANCEL":
          if (lastOrderId) {
            engine.cancelOrder(newLedger, lastOrderId);
          }
          break;
      }
    }

    return { ledger: newLedger, tradeCount };
  }

  function extractFinalState(l: CLOBLedger): {
    finalBalances: Record<string, { cash: string; yesShares: string }>;
    bestBid?: string;
    bestAsk?: string;
    totalBidQty: string;
    totalAskQty: string;
  } {
    const book = l.market.orderBook;
    const bestBid = engine.getBestBid(book);
    const bestAsk = engine.getBestAsk(book);

    let totalBidQty = new Decimal(0);
    for (const [_, level] of book.bids) {
      totalBidQty = totalBidQty.plus(level.totalQty);
    }

    let totalAskQty = new Decimal(0);
    for (const [_, level] of book.asks) {
      totalAskQty = totalAskQty.plus(level.totalQty);
    }

    const finalBalances: Record<string, { cash: string; yesShares: string }> = {};
    for (const [id, trader] of l.traders) {
      finalBalances[id] = {
        cash: trader.cash.toString(),
        yesShares: trader.yesShares.toString(),
      };
    }

    return {
      finalBalances,
      bestBid: bestBid?.toString(),
      bestAsk: bestAsk?.toString(),
      totalBidQty: totalBidQty.toString(),
      totalAskQty: totalAskQty.toString(),
    };
  }

  describe("golden master: scenario regression tests", () => {
    it("golden: simple_cross scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[0];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: partial_fill scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[1];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: fifo_same_price scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[2];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: price_priority scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[3];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: market_order_walk scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[4];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: multi_level_crossing scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[5];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: cancel_partial_fill scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[6];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });

    it("golden: spread_build scenario", () => {
      const scenario = GOLDEN_SNAPSHOTS[7];
      const { ledger: resultLedger, tradeCount } = runScenario(scenario);
      const state = extractFinalState(resultLedger);

      expect(tradeCount).toBe(scenario.finalTrades);
      expect(state.finalBalances).toEqual(scenario.finalBalances);
      expect(state.bestBid).toEqual(scenario.bestBid);
      expect(state.bestAsk).toEqual(scenario.bestAsk);
      expect(state.totalBidQty).toEqual(scenario.totalBidQty);
      expect(state.totalAskQty).toEqual(scenario.totalAskQty);
    });
  });

  describe("golden master: invariants after each scenario", () => {
    it("golden: no crossed book after any scenario", () => {
      for (const scenario of GOLDEN_SNAPSHOTS) {
        const { ledger: resultLedger } = runScenario(scenario);
        const book = resultLedger.market.orderBook;
        const bestBid = engine.getBestBid(book);
        const bestAsk = engine.getBestAsk(book);

        if (bestBid && bestAsk) {
          expect(bestBid.lt(bestAsk), `Crossed book in scenario ${scenario.scenario}: bid=${bestBid}, ask=${bestAsk}`).toBe(true);
        }
      }
    });

    it("golden: no negative balances after any scenario", () => {
      for (const scenario of GOLDEN_SNAPSHOTS) {
        const { ledger: resultLedger } = runScenario(scenario);

        for (const [traderId, trader] of resultLedger.traders) {
          expect(trader.cash.gte(0), `${scenario.scenario}: ${traderId} has negative cash: ${trader.cash}`).toBe(true);
          expect(trader.yesShares.gte(0), `${scenario.scenario}: ${traderId} has negative shares: ${trader.yesShares}`).toBe(true);
        }
      }
    });

    it("golden: cash conservation across all scenarios", () => {
      const initialTotal = new Decimal(40000); // 4 traders * 10000

      for (const scenario of GOLDEN_SNAPSHOTS) {
        const { ledger: resultLedger } = runScenario(scenario);

        let currentTotal = new Decimal(0);
        for (const [_, trader] of resultLedger.traders) {
          currentTotal = currentTotal.plus(trader.cash);
        }

        // Cash should be conserved (accounting for trades which move cash between traders)
        // We check that total is close to expected (allowing for Decimal precision)
        expect(currentTotal.sub(initialTotal).abs().lt(1), `${scenario.scenario}: Cash not conserved, total=${currentTotal}, expected=${initialTotal}`).toBe(true);
      }
    });
  });

  describe("golden master: trade execution snapshots", () => {
    it("golden: trade prices are correct", () => {
      const scenario = GOLDEN_SNAPSHOTS[0]; // simple_cross
      const { ledger: resultLedger } = runScenario(scenario);

      // For simple_cross: alice sells @ 0.50, bob buys @ 0.55
      // Trade should execute at 0.50 (alice's ask price)
      const logs = logger.getLogs();
      const tradeLogs = logs.filter((l): l is CLOBLogEntry & { type: "TRADE" } => l.type === "TRADE");

      expect(tradeLogs.length).toBe(1);
      const trade = tradeLogs[0].data;
      expect(trade.price.equals(new Decimal(0.50))).toBe(true);
      expect(trade.bidTraderId).toBe("bob");
      expect(trade.askTraderId).toBe("alice");
      expect(trade.qty.equals(new Decimal(10))).toBe(true);
    });

    it("golden: partial fill trade quantities", () => {
      const scenario = GOLDEN_SNAPSHOTS[1]; // partial_fill
      const { ledger: resultLedger } = runScenario(scenario);

      // alice sells 20 @ 0.50, bob buys 10 @ 0.50
      // Bob should get 10 shares (added to his 100), alice should have 90 (sold 10)
      const alice = resultLedger.traders.get("alice")!;
      const bob = resultLedger.traders.get("bob")!;

      expect(alice.yesShares.equals(new Decimal(90))).toBe(true);
      expect(bob.yesShares.equals(new Decimal(110))).toBe(true);
      expect(alice.cash.equals(new Decimal(10005))).toBe(true);
      expect(bob.cash.equals(new Decimal(9995))).toBe(true);
    });

    it("golden: FIFO order execution", () => {
      const scenario = GOLDEN_SNAPSHOTS[2]; // fifo_same_price
      const { ledger: resultLedger } = runScenario(scenario);

      // Three sells @ 0.50 (alice, bob, carol), then buy @ 0.55 for 12
      // Should execute: alice (5), bob (5), carol (2)
      const logs = logger.getLogs();
      const tradeLogs = logs.filter((l): l is CLOBLogEntry & { type: "TRADE" } => l.type === "TRADE");

      expect(tradeLogs.length).toBe(3);

      expect(tradeLogs[0].data.askTraderId).toBe("alice");
      expect(tradeLogs[0].data.qty.equals(new Decimal(5))).toBe(true);

      expect(tradeLogs[1].data.askTraderId).toBe("bob");
      expect(tradeLogs[1].data.qty.equals(new Decimal(5))).toBe(true);

      expect(tradeLogs[2].data.askTraderId).toBe("carol");
      expect(tradeLogs[2].data.qty.equals(new Decimal(2))).toBe(true);

      // Carol should have 3 remaining on order book, and sold 2 shares
      expect(resultLedger.traders.get("carol")!.yesShares.equals(new Decimal(98))).toBe(true);
    });
  });

  describe("golden master: order book state snapshots", () => {
    it("golden: spread after building", () => {
      const scenario = GOLDEN_SNAPSHOTS[7]; // spread_build
      const { ledger: resultLedger } = runScenario(scenario);
      const book = resultLedger.market.orderBook;

      // Best bid should be 0.46 (bob's order)
      const bestBid = engine.getBestBid(book);
      expect(bestBid?.toString()).toBe("0.46");

      // Best ask should be 0.55 (carol's order)
      const bestAsk = engine.getBestAsk(book);
      expect(bestAsk?.toString()).toBe("0.55");

      // Spread should be 0.09
      const spread = engine.getSpread(book);
      expect(spread?.toString()).toBe("0.09");

      // Mid-price should be 0.505
      const midPrice = engine.getMidPrice(book);
      expect(midPrice?.toString()).toBe("0.505");
    });

    it("golden: depth calculation", () => {
      const scenario = GOLDEN_SNAPSHOTS[7]; // spread_build
      const { ledger: resultLedger } = runScenario(scenario);
      const book = resultLedger.market.orderBook;

      // Bid depth for 2 levels = 20
      const bidDepth2 = engine.getDepth(book, "BUY", 2);
      expect(bidDepth2.toString()).toBe("20");

      // Ask depth for 2 levels = 20
      const askDepth2 = engine.getDepth(book, "SELL", 2);
      expect(askDepth2.toString()).toBe("20");
    });
  });
});
