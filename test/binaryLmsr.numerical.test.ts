/**
 * Numerical Stability and Precision Tests for Binary LMSR
 *
 * Tests:
 * - Extreme q values (large positive/negative)
 * - Tiny trades and rounding drift
 * - Numerical stability of log-sum-exp
 * - Price saturation near boundaries
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { BinaryLMSR, Ledger, MarketState } from "../src/lib/binaryLmsr";

function expectDecimalClose(
  actual: Decimal | number,
  expected: Decimal | number,
  tolerance: number = 1e-10
): void {
  const a = actual instanceof Decimal ? actual : new Decimal(actual);
  const e = expected instanceof Decimal ? expected : new Decimal(expected);
  const diff = a.minus(e).abs().toNumber();
  expect(diff).toBeLessThanOrEqual(tolerance);
}

function expectDecimalEqual(
  actual: Decimal | number,
  expected: Decimal | number
): void {
  const a = actual instanceof Decimal ? actual : new Decimal(actual);
  const e = expected instanceof Decimal ? expected : new Decimal(expected);
  expect(a.toString()).toBe(e.toString());
}

function isValidNumber(d: Decimal | number): boolean {
  const n = d instanceof Decimal ? d.toNumber() : d;
  return (
    typeof n === "number" &&
    !isNaN(n) &&
    isFinite(n) &&
    n > -1e308 &&
    n < 1e308
  );
}

describe("BinaryLMSR: Numerical Stability and Precision", () => {
  let lmsr: BinaryLMSR;
  let ledger: Ledger;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
    // Use high liquidity for extreme tests
    ledger = lmsr.initLedger(1000, [
      { id: "alice", cash: 1000000 },
      { id: "bob", cash: 1000000 },
    ]);
  });

  describe("Extreme q Values", () => {
    it("should handle large positive qYES", () => {
      const largeQ = 1e6;
      const state: MarketState = {
        qYes: new Decimal(largeQ),
        qNo: new Decimal(0),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);
      const cost = lmsr.cost(state);

      // Should not produce NaN or Inf
      expect(isValidNumber(prices.pYES)).toBe(true);
      expect(isValidNumber(prices.pNO)).toBe(true);
      expect(isValidNumber(cost)).toBe(true);

      // Price should be very close to 1
      expect(prices.pYES.toNumber()).toBeGreaterThan(0.99);
      expect(prices.pNO.toNumber()).toBeLessThan(0.01);
    });

    it("should handle large positive qNO", () => {
      const largeQ = 1e6;
      const state: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(largeQ),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);
      const cost = lmsr.cost(state);

      expect(isValidNumber(prices.pYES)).toBe(true);
      expect(isValidNumber(prices.pNO)).toBe(true);
      expect(isValidNumber(cost)).toBe(true);

      // Price should be very close to 0
      expect(prices.pYES.toNumber()).toBeLessThan(0.01);
      expect(prices.pNO.toNumber()).toBeGreaterThan(0.99);
    });

    it("should handle large negative qYES", () => {
      const largeNegativeQ = -1e6;
      const state: MarketState = {
        qYes: new Decimal(largeNegativeQ),
        qNo: new Decimal(0),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);
      const cost = lmsr.cost(state);

      expect(isValidNumber(prices.pYES)).toBe(true);
      expect(isValidNumber(prices.pNO)).toBe(true);
      expect(isValidNumber(cost)).toBe(true);

      // Negative qYES pushes price toward 0
      expect(prices.pYES.toNumber()).toBeLessThan(0.01);
    });

    it("should handle large negative qNO", () => {
      const largeNegativeQ = -1e6;
      const state: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(largeNegativeQ),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);
      const cost = lmsr.cost(state);

      expect(isValidNumber(prices.pYES)).toBe(true);
      expect(isValidNumber(prices.pNO)).toBe(true);
      expect(isValidNumber(cost)).toBe(true);

      // Negative qNO pushes pYES toward 1
      expect(prices.pYES.toNumber()).toBeGreaterThan(0.99);
    });

    it("should handle both large positive q values", () => {
      const largeQ = 1e5;
      const state: MarketState = {
        qYes: new Decimal(largeQ),
        qNo: new Decimal(largeQ),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);

      // Both large positive → price should be ~0.5
      expectDecimalClose(prices.pYES, 0.5, 0.01);
      expectDecimalClose(prices.pNO, 0.5, 0.01);
    });

    it("should maintain finite cost differences for extreme values", () => {
      const state1: MarketState = {
        qYes: new Decimal(1e6),
        qNo: new Decimal(0),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const state2: MarketState = {
        qYes: new Decimal(1e6 + 100),
        qNo: new Decimal(0),
        b: new Decimal(1000),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const cost1 = lmsr.cost(state1);
      const cost2 = lmsr.cost(state2);
      const diff = cost2.minus(cost1);

      // Cost difference should be finite
      expect(isValidNumber(diff)).toBe(true);
      // And should be approximately 100 (the quantity added)
      expectDecimalClose(diff, 100, 1);
    });
  });

  describe("Price Saturation Near Boundaries", () => {
    it("should saturate near pYES = 1 for very high qYES", () => {
      const testCases = [
        { qYes: 100, qNo: 0, b: 10 },
        { qYes: 500, qNo: 0, b: 10 },
        { qYes: 1000, qNo: 0, b: 10 },
      ];

      for (const tc of testCases) {
        const state: MarketState = {
          qYes: new Decimal(tc.qYes),
          qNo: new Decimal(tc.qNo),
          b: new Decimal(tc.b),
          totalCollected: new Decimal(0),
          settled: false,
        };

        const prices = lmsr.getPrices(state);

        // Price should be very close to 1 but not exceed it
        expect(prices.pYES.toNumber()).toBeGreaterThan(0.9);
        expect(prices.pYES.toNumber()).toBeLessThanOrEqual(1.0);
        expect(prices.pYES.toNumber()).toBeGreaterThanOrEqual(0.0);
      }
    });

    it("should saturate near pYES = 0 for very high qNO", () => {
      const testCases = [
        { qYes: 0, qNo: 100, b: 10 },
        { qYes: 0, qNo: 500, b: 10 },
        { qYes: 0, qNo: 1000, b: 10 },
      ];

      for (const tc of testCases) {
        const state: MarketState = {
          qYes: new Decimal(tc.qYes),
          qNo: new Decimal(tc.qNo),
          b: new Decimal(tc.b),
          totalCollected: new Decimal(0),
          settled: false,
        };

        const prices = lmsr.getPrices(state);

        expect(prices.pYES.toNumber()).toBeLessThan(0.1);
        expect(prices.pYES.toNumber()).toBeGreaterThanOrEqual(0.0);
      }
    });

    it("should maintain pYES + pNO = 1 even at extremes", () => {
      const extremeStates = [
        { qYes: 1e6, qNo: 0, b: 100 },
        { qYes: 0, qNo: 1e6, b: 100 },
        { qYes: -1e6, qNo: 0, b: 100 },
        { qYes: 0, qNo: -1e6, b: 100 },
        { qYes: 1e6, qNo: 1e6, b: 100 },
      ];

      for (const es of extremeStates) {
        const state: MarketState = {
          qYes: new Decimal(es.qYes),
          qNo: new Decimal(es.qNo),
          b: new Decimal(es.b),
          totalCollected: new Decimal(0),
          settled: false,
        };

        const prices = lmsr.getPrices(state);
        const sum = prices.pYES.plus(prices.pNO);

        expectDecimalClose(sum, 1, 1e-10);
      }
    });
  });

  describe("Tiny Trades and Rounding Drift", () => {
    it("should handle repeated micro-buys without breaking invariants", () => {
      const microQty = 0.01;
      const numTrades = 1000;

      const initialPrices = lmsr.getPrices(ledger.market);

      for (let i = 0; i < numTrades; i++) {
        const result = lmsr.executeBuy(ledger, "alice", "YES", microQty);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);

        // Check invariants each trade
        const prices = lmsr.getPrices(ledger.market);
        const sum = prices.pYES.plus(prices.pNO);

        expectDecimalClose(sum, 1, 1e-10);
        expect(prices.pYES.toNumber()).toBeGreaterThanOrEqual(0);
        expect(prices.pYES.toNumber()).toBeLessThanOrEqual(1);
      }

      // Final check
      const finalPrices = lmsr.getPrices(ledger.market);
      expect(finalPrices.pYES.gt(initialPrices.pYES)).toBe(true);
    });

    it("should not accumulate significant rounding error", () => {
      // Same trade in one shot vs split
      const totalQty = 10;
      const splitCount = 100;
      const qtyPerSplit = totalQty / splitCount;

      // One shot
      const ledger1 = lmsr.initLedger(100, [{ id: "alice", cash: 100000 }]);
      const result1 = lmsr.executeBuy(ledger1, "alice", "YES", totalQty);

      // Split
      const ledger2 = lmsr.initLedger(100, [{ id: "alice", cash: 100000 }]);
      let totalSpend = new Decimal(0);
      let currentState = ledger2.market;

      for (let i = 0; i < splitCount; i++) {
        const result = lmsr.executeBuy(ledger2, "alice", "YES", qtyPerSplit);
        totalSpend = totalSpend.plus(result.spend);
        ledger2.market = result.newState;
        ledger2.traders.set("alice", result.newTraderAccount);
      }

      // Costs should be very close
      expectDecimalClose(result1.spend, totalSpend, 0.01);
    });

    it("should handle minimum decimal precision trades", () => {
      const tinyQty = 0.000001;

      const quote = lmsr.quoteQtyBuy(ledger.market, "YES", tinyQty);
      const result = lmsr.executeBuy(ledger, "alice", "YES", tinyQty);

      expect(quote.qty.toNumber()).toBeGreaterThan(0);
      expect(result.qty.toNumber()).toBeGreaterThan(0);
      expect(isValidNumber(quote.payment)).toBe(true);
      expect(isValidNumber(result.spend)).toBe(true);
    });
  });

  describe("Log-Sum-Exp Numerical Stability", () => {
    it("should not overflow for large exponent arguments", () => {
      // This tests the log-sum-exp stability trick
      const state: MarketState = {
        qYes: new Decimal(10000),
        qNo: new Decimal(10000),
        b: new Decimal(1),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const cost = lmsr.cost(state);
      const prices = lmsr.getPrices(state);

      // Should not overflow
      expect(isValidNumber(cost)).toBe(true);
      expect(isValidNumber(prices.pYES)).toBe(true);
      expect(isValidNumber(prices.pNO)).toBe(true);
    });

    it("should compute cost using stable log-sum-exp form", () => {
      // The implementation uses: max + log(exp(x-max) + exp(y-max))
      // This is numerically stable even for large values

      const testCases = [
        { qYes: 1000, qNo: 2000, b: 100 },
        { qYes: 5000, qNo: 100, b: 100 },
        { qYes: 10000, qNo: 10000, b: 100 },
      ];

      for (const tc of testCases) {
        const state: MarketState = {
          qYes: new Decimal(tc.qYes),
          qNo: new Decimal(tc.qNo),
          b: new Decimal(tc.b),
          totalCollected: new Decimal(0),
          settled: false,
        };

        const cost = lmsr.cost(state);

        // Cost should be finite and positive
        expect(isValidNumber(cost)).toBe(true);
        expect(cost.toNumber()).toBeGreaterThan(0);
      }
    });
  });

  describe("Price Calculation Stability", () => {
    it("should maintain monotonic prices through many small trades", () => {
      const prices: number[] = [];
      const numTrades = 100;
      const qty = 1;

      for (let i = 0; i < numTrades; i++) {
        const result = lmsr.executeBuy(ledger, "alice", "YES", qty);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);

        const currentPrices = lmsr.getPrices(ledger.market);
        prices.push(currentPrices.pYES.toNumber());
      }

      // Each price should be higher than the previous
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThan(prices[i - 1]);
      }
    });

    it("should handle price near 0.5 without precision loss", () => {
      // State that should give pYES ≈ 0.5
      const state: MarketState = {
        qYes: new Decimal(100),
        qNo: new Decimal(100),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);

      expectDecimalClose(prices.pYES, 0.5, 1e-10);
      expectDecimalClose(prices.pNO, 0.5, 1e-10);
    });

    it("should compute very small prices accurately", () => {
      // qYES << qNO should give very small pYES
      const state: MarketState = {
        qYes: new Decimal(1),
        qNo: new Decimal(1000),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);

      expect(prices.pYES.toNumber()).toBeLessThan(0.01);
      expect(prices.pNO.toNumber()).toBeGreaterThan(0.99);

      // Sum should still be 1
      expectDecimalClose(prices.pYES.plus(prices.pNO), 1, 1e-10);
    });
  });

  describe("Decimal Precision Edge Cases", () => {
    it("should handle exactly zero quantities", () => {
      const state: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(0),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);
      const cost = lmsr.cost(state);

      expectDecimalEqual(prices.pYES, new Decimal(0.5));
      expectDecimalEqual(prices.pNO, new Decimal(0.5));
      expectDecimalClose(cost, 100 * Math.LN2, 1e-10);
    });

    it("should preserve precision through multiple operations", () => {
      // Perform multiple trades and check that precision is maintained
      const trades = [
        { outcome: "YES" as const, qty: 10.5 },
        { outcome: "NO" as const, qty: 15.3 },
        { outcome: "YES" as const, qty: 5.2 },
        { outcome: "NO" as const, qty: 8.7 },
      ];

      for (const trade of trades) {
        const result = lmsr.executeBuy(ledger, "alice", trade.outcome, trade.qty);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);

        // Verify prices are valid after each trade
        const prices = lmsr.getPrices(ledger.market);
        expect(isValidNumber(prices.pYES)).toBe(true);
        expect(isValidNumber(prices.pNO)).toBe(true);
        expectDecimalClose(prices.pYES.plus(prices.pNO), 1, 1e-10);
      }
    });
  });
});
