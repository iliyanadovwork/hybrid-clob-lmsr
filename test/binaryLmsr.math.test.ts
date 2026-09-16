/**
 * Mathematical Correctness Tests for Binary LMSR
 *
 * Tests core LMSR mathematical properties:
 * - Cost function correctness
 * - Price as gradient of cost (finite difference verification)
 * - Probability bounds and simplex property
 * - Translation invariance
 * - Symmetry
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { BinaryLMSR, MarketState } from "../src/lib/binaryLmsr";

// Helper to compare Decimals with tolerance
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

// Helper to compare Decimals exactly
function expectDecimalEqual(
  actual: Decimal | number,
  expected: Decimal | number
): void {
  const a = actual instanceof Decimal ? actual : new Decimal(actual);
  const e = expected instanceof Decimal ? expected : new Decimal(expected);
  expect(a.toString()).toBe(e.toString());
}

describe("BinaryLMSR: Mathematical Correctness", () => {
  let lmsr: BinaryLMSR;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
  });

  describe("Cost Function Correctness", () => {
    it("should match the analytical cost formula for empty state", () => {
      const state: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(0),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const cost = lmsr.cost(state);
      // C(0,0) = b * ln(1 + 1) = b * ln(2)
      const expected = new Decimal(100).times(new Decimal(Math.LN2));
      expectDecimalClose(cost, expected, 1e-10);
    });

    it("should match analytical cost for non-zero shares", () => {
      const testCases = [
        { qYes: 10, qNo: 5, b: 100 },
        { qYes: 50, qNo: 30, b: 100 },
        { qYes: 100, qNo: 100, b: 100 },
        { qYes: 0, qNo: 50, b: 100 },
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

        // C(q) = b * ln(e^(qYes/b) + e^(qNo/b))
        const expYes = Math.exp(tc.qYes / tc.b);
        const expNo = Math.exp(tc.qNo / tc.b);
        const expected = tc.b * Math.log(expYes + expNo);

        expectDecimalClose(cost, expected, 1e-10);
      }
    });

    it("should handle different b values correctly", () => {
      const bValues = [10, 50, 100, 500, 1000];

      for (const b of bValues) {
        const state: MarketState = {
          qYes: new Decimal(50),
          qNo: new Decimal(30),
          b: new Decimal(b),
          totalCollected: new Decimal(0),
          settled: false,
        };

        const cost = lmsr.cost(state);

        const expYes = Math.exp(50 / b);
        const expNo = Math.exp(30 / b);
        const expected = b * Math.log(expYes + expNo);

        expectDecimalClose(cost, expected, 1e-10);
      }
    });
  });

  describe("Price as Gradient of Cost", () => {
    it("should compute pYES using softmax formula", () => {
      const testCases = [
        { qYes: 0, qNo: 0, b: 100, expectedPYes: 0.5 },
        { qYes: 100, qNo: 0, b: 100, expectedPYes: 1 / (1 + Math.exp(-1)) },
        { qYes: 0, qNo: 100, b: 100, expectedPYes: 1 / (1 + Math.exp(1)) },
        { qYes: 50, qNo: 50, b: 100, expectedPYes: 0.5 },
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

        // pYES = e^(qYes/b) / (e^(qYes/b) + e^(qNo/b))
        const expYes = Math.exp(tc.qYes / tc.b);
        const expNo = Math.exp(tc.qNo / tc.b);
        const expectedPYes = expYes / (expYes + expNo);

        expectDecimalClose(prices.pYES, expectedPYes, 1e-10);
        expectDecimalClose(prices.pNO, 1 - expectedPYes, 1e-10);
      }
    });

    it("should verify finite-difference derivative matches computed price", () => {
      const state: MarketState = {
        qYes: new Decimal(50),
        qNo: new Decimal(30),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);

      // Finite difference approximation: dC/dqYes ≈ (C(qYes + h) - C(qYes)) / h
      const h = 0.0001;
      const costBefore = lmsr.cost(state);

      const stateAfter: MarketState = {
        ...state,
        qYes: state.qYes.plus(h),
      };
      const costAfter = lmsr.cost(stateAfter);

      const finiteDiffPrice = costAfter.minus(costBefore).div(h);

      // Finite difference should be very close to computed price
      expectDecimalClose(finiteDiffPrice, prices.pYES, 0.001);
    });

    it("should verify finite-difference for qNO derivative", () => {
      const state: MarketState = {
        qYes: new Decimal(50),
        qNo: new Decimal(30),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);

      // Finite difference for dC/dqNo
      const h = 0.0001;
      const costBefore = lmsr.cost(state);

      const stateAfter: MarketState = {
        ...state,
        qNo: state.qNo.plus(h),
      };
      const costAfter = lmsr.cost(stateAfter);

      const finiteDiffPrice = costAfter.minus(costBefore).div(h);

      // dC/dqNo should equal pNO
      expectDecimalClose(finiteDiffPrice, prices.pNO, 0.001);
    });
  });

  describe("Probability Bounds and Simplex", () => {
    it("should always have pYES in [0, 1]", () => {
      const testCases = [
        { qYes: 0, qNo: 0, b: 100 },
        { qYes: 1000, qNo: 0, b: 100 },
        { qYes: 0, qNo: 1000, b: 100 },
        { qYes: 100, qNo: 100, b: 100 },
        { qYes: -100, qNo: 100, b: 100 },
        { qYes: 100, qNo: -100, b: 100 },
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

        expect(prices.pYES.toNumber()).toBeGreaterThanOrEqual(0);
        expect(prices.pYES.toNumber()).toBeLessThanOrEqual(1);
      }
    });

    it("should always have pNO in [0, 1]", () => {
      const testCases = [
        { qYes: 0, qNo: 0, b: 100 },
        { qYes: 1000, qNo: 0, b: 100 },
        { qYes: 0, qNo: 1000, b: 100 },
        { qYes: 100, qNo: 100, b: 100 },
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

        expect(prices.pNO.toNumber()).toBeGreaterThanOrEqual(0);
        expect(prices.pNO.toNumber()).toBeLessThanOrEqual(1);
      }
    });

    it("should always have pYES + pNO = 1", () => {
      const testCases = [
        { qYes: 0, qNo: 0, b: 100 },
        { qYes: 50, qNo: 30, b: 100 },
        { qYes: 100, qNo: 100, b: 100 },
        { qYes: 200, qNo: 50, b: 100 },
        { qYes: -50, qNo: 100, b: 100 },
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
        const sum = prices.pYES.plus(prices.pNO);

        expectDecimalClose(sum, 1, 1e-10);
      }
    });
  });

  describe("Translation Invariance", () => {
    it("should keep prices unchanged when adding constant to both qYES and qNO", () => {
      const baseState: MarketState = {
        qYes: new Decimal(50),
        qNo: new Decimal(30),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const pricesBefore = lmsr.getPrices(baseState);

      // Add constant c to both
      const c = 25;
      const shiftedState: MarketState = {
        ...baseState,
        qYes: baseState.qYes.plus(c),
        qNo: baseState.qNo.plus(c),
      };

      const pricesAfter = lmsr.getPrices(shiftedState);

      // Prices should be identical
      expectDecimalEqual(pricesBefore.pYES, pricesAfter.pYES);
      expectDecimalEqual(pricesBefore.pNO, pricesAfter.pNO);
    });

    it("should increase cost by exactly c when adding constant to both quantities", () => {
      const baseState: MarketState = {
        qYes: new Decimal(50),
        qNo: new Decimal(30),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const costBefore = lmsr.cost(baseState);

      // Add constant c to both
      const c = 25;
      const shiftedState: MarketState = {
        ...baseState,
        qYes: baseState.qYes.plus(c),
        qNo: baseState.qNo.plus(c),
      };

      const costAfter = lmsr.cost(shiftedState);

      // Cost should increase by exactly c
      // C(q+c, q+c) = C(q,q) + c
      const expectedCost = costBefore.plus(c);
      expectDecimalClose(costAfter, expectedCost, 1e-10);
    });

    it("should work for multiple shift values", () => {
      const baseState: MarketState = {
        qYes: new Decimal(100),
        qNo: new Decimal(50),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const costBefore = lmsr.cost(baseState);
      const pricesBefore = lmsr.getPrices(baseState);

      const shifts = [10, 50, 100, 500];

      for (const c of shifts) {
        const shiftedState: MarketState = {
          ...baseState,
          qYes: baseState.qYes.plus(c),
          qNo: baseState.qNo.plus(c),
        };

        const costAfter = lmsr.cost(shiftedState);
        const pricesAfter = lmsr.getPrices(shiftedState);

        expectDecimalClose(costAfter, costBefore.plus(c), 1e-10);
        expectDecimalEqual(pricesBefore.pYES, pricesAfter.pYES);
        expectDecimalEqual(pricesBefore.pNO, pricesAfter.pNO);
      }
    });
  });

  describe("Symmetry", () => {
    it("should swap prices when swapping quantities", () => {
      const state1: MarketState = {
        qYes: new Decimal(60),
        qNo: new Decimal(40),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const state2: MarketState = {
        qYes: new Decimal(40),
        qNo: new Decimal(60),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices1 = lmsr.getPrices(state1);
      const prices2 = lmsr.getPrices(state2);

      // pYES of state1 should equal pNO of state2 (within numerical precision)
      expectDecimalClose(prices1.pYES, prices2.pNO, 1e-15);
      // pNO of state1 should equal pYES of state2 (within numerical precision)
      expectDecimalClose(prices1.pNO, prices2.pYES, 1e-15);
    });

    it("should have symmetric prices when qYES = qNO", () => {
      const state: MarketState = {
        qYes: new Decimal(100),
        qNo: new Decimal(100),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const prices = lmsr.getPrices(state);

      expectDecimalEqual(prices.pYES, new Decimal(0.5));
      expectDecimalEqual(prices.pNO, new Decimal(0.5));
    });

    it("should maintain cost symmetry under swap", () => {
      const state1: MarketState = {
        qYes: new Decimal(70),
        qNo: new Decimal(30),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const state2: MarketState = {
        qYes: new Decimal(30),
        qNo: new Decimal(70),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const cost1 = lmsr.cost(state1);
      const cost2 = lmsr.cost(state2);

      // Cost should be the same when quantities are swapped
      expectDecimalEqual(cost1, cost2);
    });
  });
});
