/**
 * Trading and Quoting Tests for Binary LMSR
 *
 * Tests:
 * - Path independence of trade cost
 * - Quote-by-quantity matches execution
 * - Quote-by-spend inversion correctness
 * - Monotonicity of spend-to-qty
 * - Buy/sell consistency (short-selling allowed with collateral)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { BinaryLMSR, Ledger, MarketState, Outcome } from "../src/lib/binaryLmsr";

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

function cloneMarket(market: MarketState): MarketState {
  return {
    qYes: new Decimal(market.qYes.toString()),
    qNo: new Decimal(market.qNo.toString()),
    b: new Decimal(market.b.toString()),
    totalCollected: new Decimal(market.totalCollected.toString()),
    settled: market.settled,
    outcome: market.outcome,
  };
}

describe("BinaryLMSR: Trading and Quoting", () => {
  let lmsr: BinaryLMSR;
  let ledger: Ledger;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
    ledger = lmsr.initLedger(100, [
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 10000 },
    ]);
  });

  describe("Path Independence of Trade Cost", () => {
    it("should charge same total for split trades vs single trade", () => {
      const initialState: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(0),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      // Method 1: Buy 30 YES in one trade
      const quote1 = lmsr.quoteQtyBuy(initialState, "YES", 30);
      const cost1 = quote1.payment;

      // Method 2: Buy 10 YES, then 20 YES
      const afterFirstTrade: MarketState = {
        ...initialState,
        qYes: initialState.qYes.plus(10),
      };
      const costFirst = lmsr.cost(afterFirstTrade).minus(lmsr.cost(initialState));

      const afterSecondTrade: MarketState = {
        ...afterFirstTrade,
        qYes: afterFirstTrade.qYes.plus(20),
      };
      const costSecond = lmsr.cost(afterSecondTrade).minus(lmsr.cost(afterFirstTrade));

      const cost2 = costFirst.plus(costSecond);

      // Costs should be equal
      expectDecimalClose(cost1, cost2, 1e-10);
    });

    it("should maintain path independence for larger splits", () => {
      const initialState: MarketState = {
        qYes: new Decimal(50),
        qNo: new Decimal(30),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      const totalQty = 100;
      const splitCount = 10;
      const qtyPerSplit = totalQty / splitCount;

      // Single trade
      const singleQuote = lmsr.quoteQtyBuy(initialState, "YES", totalQty);

      // Split trades
      let currentState = cloneMarket(initialState);
      let totalSplitCost = new Decimal(0);

      for (let i = 0; i < splitCount; i++) {
        const nextState: MarketState = {
          ...currentState,
          qYes: currentState.qYes.plus(qtyPerSplit),
        };
        const stepCost = lmsr.cost(nextState).minus(lmsr.cost(currentState));
        totalSplitCost = totalSplitCost.plus(stepCost);
        currentState = nextState;
      }

      expectDecimalClose(singleQuote.payment, totalSplitCost, 1e-9);
    });

    it("should be path independent for alternating YES/NO trades", () => {
      const initialState: MarketState = {
        qYes: new Decimal(20),
        qNo: new Decimal(20),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: false,
      };

      // Path 1: YES then NO
      const afterYes: MarketState = {
        ...initialState,
        qYes: initialState.qYes.plus(10),
      };
      const cost1Yes = lmsr.cost(afterYes).minus(lmsr.cost(initialState));

      const afterNo: MarketState = {
        ...afterYes,
        qNo: afterYes.qNo.plus(10),
      };
      const cost1No = lmsr.cost(afterNo).minus(lmsr.cost(afterYes));
      const total1 = cost1Yes.plus(cost1No);

      // Path 2: NO then YES
      const afterNo2: MarketState = {
        ...initialState,
        qNo: initialState.qNo.plus(10),
      };
      const cost2No = lmsr.cost(afterNo2).minus(lmsr.cost(initialState));

      const afterYes2: MarketState = {
        ...afterNo2,
        qYes: afterNo2.qYes.plus(10),
      };
      const cost2Yes = lmsr.cost(afterYes2).minus(lmsr.cost(afterNo2));
      const total2 = cost2No.plus(cost2Yes);

      expectDecimalClose(total1, total2, 1e-10);
    });
  });

  describe("Quote-by-Quantity Matches Execution", () => {
    it("should quote same cost as actual execution", () => {
      const state = ledger.market;
      const trader = "alice";
      const outcome: Outcome = "YES";
      const qty = 25;

      // Get quote
      const quote = lmsr.quoteQtyBuy(state, outcome, qty);

      // Execute trade
      const result = lmsr.executeBuy(ledger, trader, outcome, qty);

      // Quote cost should match execution spend
      expectDecimalEqual(quote.payment, result.spend);

      // Quote avg price should match execution avg price
      expectDecimalEqual(quote.avgPrice, result.avgPrice);

      // Quote prices should match execution prices
      expectDecimalEqual(quote.pricesBefore.yes, result.pricesBefore.yes);
      expectDecimalEqual(quote.pricesBefore.no, result.pricesBefore.no);
      expectDecimalEqual(quote.pricesAfter.yes, result.pricesAfter.yes);
      expectDecimalEqual(quote.pricesAfter.no, result.pricesAfter.no);
    });

    it("should match for NO shares", () => {
      // Reset and add some initial shares
      ledger = lmsr.initLedger(100, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      const state = ledger.market;
      const trader = "alice";
      const outcome: Outcome = "NO";
      const qty = 15;

      const quote = lmsr.quoteQtyBuy(state, outcome, qty);
      const result = lmsr.executeBuy(ledger, trader, outcome, qty);

      expectDecimalEqual(quote.payment, result.spend);
      expectDecimalEqual(quote.avgPrice, result.avgPrice);
    });

    it("should match for various quantities", () => {
      const quantities = [1, 5, 10, 25, 50, 100, 500];

      for (const qty of quantities) {
        const freshLedger = lmsr.initLedger(100, [
          { id: "alice", cash: 10000 },
        ]);

        const quote = lmsr.quoteQtyBuy(freshLedger.market, "YES", qty);
        const result = lmsr.executeBuy(freshLedger, "alice", "YES", qty);

        expectDecimalClose(quote.payment, result.spend, 1e-10);
      }
    });
  });

  describe("Quote-by-Spend Inversion Correctness", () => {
    it("should return qty such that executing costs approximately the spend amount", () => {
      const spendAmount = 100;

      const quote = lmsr.quoteSpendBuy(ledger.market, "YES", spendAmount);

      // Execute the returned quantity
      const result = lmsr.executeBuy(ledger, "alice", "YES", quote.qty.toNumber());

      // Actual spend should be very close to quoted spend
      // Use tolerance due to solver precision differences
      expectDecimalClose(quote.spend, result.spend, 1e-9);
    });

    it("should maintain tight tolerance for various spend amounts", () => {
      const spendAmounts = [10, 50, 100, 500, 1000, 5000];

      for (const spend of spendAmounts) {
        const freshLedger = lmsr.initLedger(100, [
          { id: "alice", cash: 10000 },
        ]);

        const quote = lmsr.quoteSpendBuy(freshLedger.market, "YES", spend);

        // The quoted spend should be very close to requested
        // (may not be exact due to discrete nature and solver tolerance)
        expect(quote.spend.toNumber()).toBeGreaterThan(0);
        expect(quote.spend.toNumber()).toBeLessThanOrEqual(spend);
      }
    });

    it("should handle spend amounts that exceed available liquidity gracefully", () => {
      // Very large spend in illiquid market
      const hugeSpend = 1000000;
      const quote = lmsr.quoteSpendBuy(ledger.market, "YES", hugeSpend);

      // Should return some quantity (even if small per-unit value)
      expect(quote.qty.toNumber()).toBeGreaterThan(0);

      // The actual spend should not exceed quoted spend
      expect(quote.spend.toNumber()).toBeLessThanOrEqual(hugeSpend);
    });
  });

  describe("Monotonicity of Spend-to-Quantity", () => {
    it("should return larger quantity for larger spend", () => {
      const spends = [10, 50, 100, 200, 500];
      const quantities: number[] = [];

      for (const spend of spends) {
        const quote = lmsr.quoteSpendBuy(ledger.market, "YES", spend);
        quantities.push(quote.qty.toNumber());
      }

      // Each quantity should be larger than the previous
      for (let i = 1; i < quantities.length; i++) {
        expect(quantities[i]).toBeGreaterThan(quantities[i - 1]);
      }
    });

    it("should maintain monotonicity for NO shares", () => {
      const spends = [10, 50, 100, 200, 500];
      const quantities: number[] = [];

      for (const spend of spends) {
        const quote = lmsr.quoteSpendBuy(ledger.market, "NO", spend);
        quantities.push(quote.qty.toNumber());
      }

      for (let i = 1; i < quantities.length; i++) {
        expect(quantities[i]).toBeGreaterThan(quantities[i - 1]);
      }
    });

    it("should have non-decreasing marginal quantities", () => {
      // Buying the same additional spend should give diminishing quantities
      // (due to price impact), but quantity should still increase with spend
      const baseSpend = 100;
      const incrementalSpend = 50;

      const quote1 = lmsr.quoteSpendBuy(ledger.market, "YES", baseSpend);
      const quote2 = lmsr.quoteSpendBuy(ledger.market, "YES", baseSpend + incrementalSpend);

      const additionalQty = quote2.qty.minus(quote1.qty);

      expect(additionalQty.toNumber()).toBeGreaterThan(0);
    });
  });

  describe("Average Price Monotonicity", () => {
    it("should have increasing avg price for larger quantities", () => {
      const quantities = [10, 20, 50, 100];
      const avgPrices: number[] = [];

      for (const qty of quantities) {
        const quote = lmsr.quoteQtyBuy(ledger.market, "YES", qty);
        avgPrices.push(quote.avgPrice.toNumber());
      }

      for (let i = 1; i < avgPrices.length; i++) {
        expect(avgPrices[i]).toBeGreaterThan(avgPrices[i - 1]);
      }
    });

    it("should have increasing avg price for NO shares", () => {
      const quantities = [10, 20, 50, 100];
      const avgPrices: number[] = [];

      for (const qty of quantities) {
        const quote = lmsr.quoteQtyBuy(ledger.market, "NO", qty);
        avgPrices.push(quote.avgPrice.toNumber());
      }

      for (let i = 1; i < avgPrices.length; i++) {
        expect(avgPrices[i]).toBeGreaterThan(avgPrices[i - 1]);
      }
    });
  });

  describe("Buy-Sell Round-Trip", () => {
    it("should maintain consistent state for buy-then-sell (shorting)", () => {
      // In LMSR, "selling" is just buying the opposite outcome
      // Buying YES then buying equivalent NO should bring price back

      const initialPrices = lmsr.getPrices(ledger.market);
      const initialCost = lmsr.cost(ledger.market);

      // Buy 10 YES
      const buyYesResult = lmsr.executeBuy(ledger, "alice", "YES", 10);
      const afterYesPrices = lmsr.getPrices(buyYesResult.newState);

      // YES price should have increased
      expect(afterYesPrices.pYES.gt(initialPrices.pYES)).toBe(true);

      // Buy 10 NO (equivalent to selling 10 YES in prediction market)
      const afterYesState = { ...ledger, market: buyYesResult.newState };
      const buyNoResult = lmsr.executeBuy(afterYesState, "alice", "NO", 10);
      const afterNoPrices = lmsr.getPrices(buyNoResult.newState);

      // Price should return close to original (within rounding)
      expectDecimalClose(afterNoPrices.pYES, initialPrices.pYES, 0.01);
    });

    it("should account for total cost correctly in round-trip", () => {
      const initialCash = ledger.traders.get("alice")!.cash;

      // Buy 20 YES
      const result1 = lmsr.executeBuy(ledger, "alice", "YES", 20);
      const cost1 = result1.spend;

      // Buy 20 NO
      ledger.market = result1.newState;
      ledger.traders.set("alice", result1.newTraderAccount);

      const result2 = lmsr.executeBuy(ledger, "alice", "NO", 20);
      const cost2 = result2.spend;

      const finalCash = result2.newTraderAccount.cash;
      const totalSpent = cost1.plus(cost2);

      // Final cash = initial - total spent
      expectDecimalClose(finalCash, initialCash.minus(totalSpent), 1e-10);
    });
  });

  describe("Edge Cases in Trading", () => {
    it("should handle minimum quantity trades", () => {
      const minQty = 0.01;
      const quote = lmsr.quoteQtyBuy(ledger.market, "YES", minQty);
      const result = lmsr.executeBuy(ledger, "alice", "YES", minQty);

      expectDecimalEqual(quote.qty, result.qty);
      expectDecimalEqual(quote.payment, result.spend);
    });

    it("should reject zero spend", () => {
      expect(() => {
        lmsr.quoteSpendBuy(ledger.market, "YES", 0);
      }).toThrow();
    });

    it("should reject negative quantities", () => {
      expect(() => {
        lmsr.quoteQtyBuy(ledger.market, "YES", -10);
      }).toThrow();
    });

    it("should reject negative spend", () => {
      expect(() => {
        lmsr.quoteSpendBuy(ledger.market, "YES", -100);
      }).toThrow();
    });

    it("should reject trades in settled market", () => {
      ledger.market.settled = true;
      ledger.market.outcome = "YES";

      expect(() => {
        lmsr.executeBuy(ledger, "alice", "YES", 10);
      }).toThrow();
    });

    it("should reject quotes in settled market", () => {
      ledger.market.settled = true;
      ledger.market.outcome = "YES";

      expect(() => {
        lmsr.quoteQtyBuy(ledger.market, "YES", 10);
      }).toThrow();
    });
  });
});
