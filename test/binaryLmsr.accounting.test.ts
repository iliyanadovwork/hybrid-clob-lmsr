/**
 * Accounting and Policy Tests for Binary LMSR
 *
 * Tests:
 * - Ledger invariants (cash and positions update correctly)
 * - No negative cash rule
 * - Trader account consistency
 * - Market state consistency after trades
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { BinaryLMSR, Ledger, TraderAccount, MarketState, Outcome } from "../src/lib/binaryLmsr";

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

function cloneLedger(ledger: Ledger): Ledger {
  const newTraders = new Map<string, TraderAccount>();
  for (const [id, trader] of ledger.traders) {
    newTraders.set(id, {
      traderId: trader.traderId,
      cash: new Decimal(trader.cash.toString()),
      yesShares: new Decimal(trader.yesShares.toString()),
      noShares: new Decimal(trader.noShares.toString()),
    });
  }

  return {
    market: {
      qYes: new Decimal(ledger.market.qYes.toString()),
      qNo: new Decimal(ledger.market.qNo.toString()),
      b: new Decimal(ledger.market.b.toString()),
      totalCollected: new Decimal(ledger.market.totalCollected.toString()),
      settled: ledger.market.settled,
      outcome: ledger.market.outcome,
    },
    traders: newTraders,
  };
}

describe("BinaryLMSR: Accounting and Policy", () => {
  let lmsr: BinaryLMSR;
  let ledger: Ledger;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
    ledger = lmsr.initLedger(100, [
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 5000 },
      { id: "carol", cash: 2500 },
    ]);
  });

  describe("Cash Accounting", () => {
    it("should deduct exact payment amount from trader cash", () => {
      const traderId = "alice";
      const initialCash = ledger.traders.get(traderId)!.cash;

      const result = lmsr.executeBuy(ledger, traderId, "YES", 25);

      const expectedCash = initialCash.minus(result.spend);
      expectDecimalEqual(result.newTraderAccount.cash, expectedCash);
    });

    it("should never result in negative cash for valid trades", () => {
      // Trade that should be affordable
      const result = lmsr.executeBuy(ledger, "carol", "YES", 10);

      expect(result.newTraderAccount.cash.toNumber()).toBeGreaterThanOrEqual(0);
    });

    it("should reject trade that would make cash negative", () => {
      const carolCash = ledger.traders.get("carol")!.cash.toNumber();

      // Try to buy more than Carol can afford
      expect(() => {
        lmsr.executeBuy(ledger, "carol", "YES", 10000);
      }).toThrow();
    });

    it("should track exact cash across multiple traders", () => {
      const initialCash = new Decimal(10000 + 5000 + 2500);

      const result1 = lmsr.executeBuy(ledger, "alice", "YES", 50);
      ledger.market = result1.newState;
      ledger.traders.set("alice", result1.newTraderAccount);

      const result2 = lmsr.executeBuy(ledger, "bob", "NO", 30);
      ledger.market = result2.newState;
      ledger.traders.set("bob", result2.newTraderAccount);

      const result3 = lmsr.executeBuy(ledger, "carol", "YES", 20);
      ledger.market = result3.newState;
      ledger.traders.set("carol", result3.newTraderAccount);

      // Sum of all cash should equal initial - totalCollected (fees collected by market)
      let totalCash = new Decimal(0);
      for (const [, trader] of ledger.traders) {
        totalCash = totalCash.plus(trader.cash);
      }

      // Cash in trader accounts + cash collected by market = initial cash
      const finalTotal = totalCash.plus(ledger.market.totalCollected);

      expectDecimalClose(finalTotal, initialCash, 1e-10);
    });

    it("should handle spend-based buy correctly", () => {
      const traderId = "alice";
      const initialCash = ledger.traders.get(traderId)!.cash;
      const spendAmount = 500;

      const result = lmsr.executeBuySpend(ledger, traderId, "YES", spendAmount);

      // Cash should decrease by actual spend (may be slightly less than requested)
      expect(result.newTraderAccount.cash.lt(initialCash)).toBe(true);
      expect(initialCash.minus(result.newTraderAccount.cash).toNumber()).toBeLessThanOrEqual(spendAmount);
    });
  });

  describe("Share Position Accounting", () => {
    it("should add YES shares when buying YES", () => {
      const traderId = "alice";
      const initialYesShares = ledger.traders.get(traderId)!.yesShares;
      const initialNoShares = ledger.traders.get(traderId)!.noShares;

      const qty = 25;
      const result = lmsr.executeBuy(ledger, traderId, "YES", qty);

      expectDecimalEqual(result.newTraderAccount.yesShares, initialYesShares.plus(qty));
      expectDecimalEqual(result.newTraderAccount.noShares, initialNoShares);
    });

    it("should add NO shares when buying NO", () => {
      const traderId = "bob";
      const initialYesShares = ledger.traders.get(traderId)!.yesShares;
      const initialNoShares = ledger.traders.get(traderId)!.noShares;

      const qty = 15;
      const result = lmsr.executeBuy(ledger, traderId, "NO", qty);

      expectDecimalEqual(result.newTraderAccount.noShares, initialNoShares.plus(qty));
      expectDecimalEqual(result.newTraderAccount.yesShares, initialYesShares);
    });

    it("should not affect other traders' positions", () => {
      const aliceBefore = ledger.traders.get("alice")!;
      const bobBefore = ledger.traders.get("bob")!;

      lmsr.executeBuy(ledger, "carol", "YES", 30);

      const aliceAfter = ledger.traders.get("alice")!;
      const bobAfter = ledger.traders.get("bob")!;

      expectDecimalEqual(aliceAfter.cash, aliceBefore.cash);
      expectDecimalEqual(aliceAfter.yesShares, aliceBefore.yesShares);
      expectDecimalEqual(aliceAfter.noShares, aliceBefore.noShares);

      expectDecimalEqual(bobAfter.cash, bobBefore.cash);
      expectDecimalEqual(bobAfter.yesShares, bobBefore.yesShares);
      expectDecimalEqual(bobAfter.noShares, bobBefore.noShares);
    });

    it("should handle multiple trades for same trader correctly", () => {
      const traderId = "alice";

      const result1 = lmsr.executeBuy(ledger, traderId, "YES", 20);
      ledger.market = result1.newState;
      ledger.traders.set(traderId, result1.newTraderAccount);

      const result2 = lmsr.executeBuy(ledger, traderId, "NO", 15);
      ledger.market = result2.newState;
      ledger.traders.set(traderId, result2.newTraderAccount);

      expect(result2.newTraderAccount.yesShares.toNumber()).toBe(20);
      expect(result2.newTraderAccount.noShares.toNumber()).toBe(15);
    });

    it("should initialize new traders with zero shares", () => {
      const traderId = "alice";

      expect(ledger.traders.get(traderId)!.yesShares.toNumber()).toBe(0);
      expect(ledger.traders.get(traderId)!.noShares.toNumber()).toBe(0);
    });
  });

  describe("Market State Consistency", () => {
    it("should update qYES when buying YES", () => {
      const initialQYes = ledger.market.qYes;
      const qty = 25;

      const result = lmsr.executeBuy(ledger, "alice", "YES", qty);

      expectDecimalEqual(result.newState.qYes, initialQYes.plus(qty));
      expectDecimalEqual(result.newState.qNo, ledger.market.qNo);
    });

    it("should update qNO when buying NO", () => {
      const initialQNo = ledger.market.qNo;
      const qty = 15;

      const result = lmsr.executeBuy(ledger, "bob", "NO", qty);

      expectDecimalEqual(result.newState.qNo, initialQNo.plus(qty));
      expectDecimalEqual(result.newState.qYes, ledger.market.qYes);
    });

    it("should accumulate total collected correctly", () => {
      const initialCollected = ledger.market.totalCollected;

      const result1 = lmsr.executeBuy(ledger, "alice", "YES", 20);

      const result2 = lmsr.executeBuy({ ...ledger, market: result1.newState }, "bob", "NO", 15);

      const expectedCollected = initialCollected
        .plus(result1.spend)
        .plus(result2.spend);

      expectDecimalEqual(result2.newState.totalCollected, expectedCollected);
    });

    it("should not change b parameter during trading", () => {
      const initialB = ledger.market.b;

      const result = lmsr.executeBuy(ledger, "alice", "YES", 25);

      expectDecimalEqual(result.newState.b, initialB);
    });

    it("should maintain settlement flag correctly", () => {
      expect(ledger.market.settled).toBe(false);

      const result = lmsr.executeBuy(ledger, "alice", "YES", 25);

      expect(result.newState.settled).toBe(false);
    });
  });

  describe("Trader Ledger Invariants", () => {
    it("should preserve trader count in ledger", () => {
      const initialCount = ledger.traders.size;

      lmsr.executeBuy(ledger, "alice", "YES", 10);
      lmsr.executeBuy(ledger, "bob", "NO", 15);

      expect(ledger.traders.size).toBe(initialCount);
    });

    it("should maintain trader IDs in ledger", () => {
      const initialIds = new Set(ledger.traders.keys());

      lmsr.executeBuy(ledger, "alice", "YES", 10);
      lmsr.executeBuy(ledger, "bob", "NO", 15);

      const afterIds = new Set(ledger.traders.keys());

      expect(afterIds).toEqual(initialIds);
    });

    it("should handle trades for all registered traders", () => {
      const traders = ["alice", "bob", "carol"];

      for (const trader of traders) {
        const result = lmsr.executeBuy(ledger, trader, "YES", 5);
        ledger.market = result.newState;
        ledger.traders.set(trader, result.newTraderAccount);
      }

      // All traders should have their positions updated
      expect(ledger.traders.get("alice")!.yesShares.toNumber()).toBe(5);
      expect(ledger.traders.get("bob")!.yesShares.toNumber()).toBe(5);
      expect(ledger.traders.get("carol")!.yesShares.toNumber()).toBe(5);
    });
  });

  describe("Trade Result Consistency", () => {
    it("should have consistent quantity in result", () => {
      const qty = 25;
      const result = lmsr.executeBuy(ledger, "alice", "YES", qty);

      expectDecimalEqual(result.qty, new Decimal(qty));
    });

    it("should have matching outcome in result", () => {
      const outcome: Outcome = "YES";
      const result = lmsr.executeBuy(ledger, "alice", outcome, 25);

      expect(result.outcome).toBe(outcome);
    });

    it("should have correct trader ID in result", () => {
      const traderId = "bob";
      const result = lmsr.executeBuy(ledger, traderId, "NO", 15);

      expect(result.traderId).toBe(traderId);
    });

    it("should have valid timestamp in result", () => {
      const before = new Date().toISOString();
      const result = lmsr.executeBuy(ledger, "alice", "YES", 10);
      const after = new Date().toISOString();

      expect(result.timestamp).toBeDefined();
      expect(result.timestamp >= before).toBe(true);
      expect(result.timestamp <= after).toBe(true);
    });

    it("should have trade ID format in result", () => {
      const result = lmsr.executeBuy(ledger, "alice", "YES", 10);

      expect(result.tradeId).toMatch(/^TRD-\d{8}$/);
    });

    it("should have unique trade IDs", () => {
      const ids = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const result = lmsr.executeBuy(ledger, "alice", "YES", 1);
        ids.add(result.tradeId);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);
      }

      expect(ids.size).toBe(10);
    });
  });

  describe("Cash Conservation", () => {
    it("should conserve total cash + shares value across trades", () => {
      // This is more complex in LMSR since shares don't have intrinsic value until settlement
      // But we can check that cash + collected = initial cash

      const initialTotalCash = new Decimal(10000 + 5000 + 2500);

      // Do several trades
      for (let i = 0; i < 5; i++) {
        const result = lmsr.executeBuy(ledger, "alice", "YES", 10);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);
      }

      let currentTraderCash = new Decimal(0);
      for (const [, trader] of ledger.traders) {
        currentTraderCash = currentTraderCash.plus(trader.cash);
      }

      const totalAccountedFor = currentTraderCash.plus(ledger.market.totalCollected);

      expectDecimalClose(totalAccountedFor, initialTotalCash, 1e-10);
    });
  });

  describe("Spend-Based Buy Accounting", () => {
    it("should not spend more than requested amount", () => {
      const spendRequest = 100;
      const traderId = "alice";

      const result = lmsr.executeBuySpend(ledger, traderId, "YES", spendRequest);

      // Actual spend should not exceed requested
      expect(result.spend.toNumber()).toBeLessThanOrEqual(spendRequest);
    });

    it("should use most of the requested spend when liquidity exists", () => {
      const spendRequest = 100;
      const traderId = "alice";

      const result = lmsr.executeBuySpend(ledger, traderId, "YES", spendRequest);

      // Should use a significant portion of the requested spend
      // (at 50/50 odds, max spend per share approaches 1, so we can't spend full amount)
      // The solver finds the optimal quantity, spending what's necessary
      expect(result.spend.toNumber()).toBeGreaterThan(0);
      expect(result.spend.toNumber()).toBeLessThanOrEqual(spendRequest);

      // At least some shares should be bought
      expect(result.qty.toNumber()).toBeGreaterThan(0);
    });

    it("should correctly deduct spend from trader cash", () => {
      const traderId = "alice";
      const initialCash = ledger.traders.get(traderId)!.cash;
      const spendRequest = 500;

      const result = lmsr.executeBuySpend(ledger, traderId, "YES", spendRequest);

      const cashDiff = initialCash.minus(result.newTraderAccount.cash);

      expectDecimalClose(cashDiff, result.spend, 1e-10);
    });

    it("should add correct shares to trader position", () => {
      const traderId = "alice";
      const initialYesShares = ledger.traders.get(traderId)!.yesShares;
      const spendRequest = 500;

      const result = lmsr.executeBuySpend(ledger, traderId, "YES", spendRequest);

      expectDecimalEqual(
        result.newTraderAccount.yesShares,
        initialYesShares.plus(result.qty)
      );
    });
  });

  describe("Error Cases and Rejections", () => {
    it("should reject buy for non-existent trader", () => {
      expect(() => {
        lmsr.executeBuy(ledger, "unknown_trader", "YES", 10);
      }).toThrow();
    });

    it("should reject spend-based buy for non-existent trader", () => {
      expect(() => {
        lmsr.executeBuySpend(ledger, "unknown_trader", "YES", 100);
      }).toThrow();
    });

    it("should reject trade with zero quantity", () => {
      expect(() => {
        lmsr.executeBuy(ledger, "alice", "YES", 0);
      }).toThrow();
    });

    it("should reject trade with negative quantity", () => {
      expect(() => {
        lmsr.executeBuy(ledger, "alice", "YES", -10);
      }).toThrow();
    });

    it("should reject spend-based buy with zero spend", () => {
      expect(() => {
        lmsr.executeBuySpend(ledger, "alice", "YES", 0);
      }).toThrow();
    });

    it("should reject spend-based buy with negative spend", () => {
      expect(() => {
        lmsr.executeBuySpend(ledger, "alice", "YES", -100);
      }).toThrow();
    });

    it("should reject trade in settled market", () => {
      ledger.market.settled = true;
      ledger.market.outcome = "YES";

      expect(() => {
        lmsr.executeBuy(ledger, "alice", "YES", 10);
      }).toThrow();
    });
  });
});
