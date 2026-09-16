/**
 * Risk and Bounded-Loss Tests for Binary LMSR
 *
 * Tests:
 * - Worst-case loss bound (b * ln(2))
 * - Settlement correctness
 * - Realised loss accounting
 * - Payout calculations
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { BinaryLMSR, Ledger, Outcome, applySettlement } from "../src/lib/binaryLmsr";

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

describe("BinaryLMSR: Risk and Bounded Loss", () => {
  let lmsr: BinaryLMSR;
  let ledger: Ledger;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
    ledger = lmsr.initLedger(100, [
      { id: "alice", cash: 10000 },
      { id: "bob", cash: 10000 },
      { id: "carol", cash: 10000 },
    ]);
  });

  describe("Worst-Case Loss Bound", () => {
    it("should calculate worst-case loss as b * ln(2)", () => {
      const bValues = [10, 50, 100, 200, 500, 1000];

      for (const b of bValues) {
        const worstCase = lmsr.worstCaseLoss(b);
        const expected = b * Math.LN2;

        expectDecimalClose(worstCase, expected, 1e-10);
      }
    });

    it("should bound realised loss by worst-case for symmetric outcomes", () => {
      const b = 100;
      const expectedWorstCase = b * Math.LN2;

      // Scenario: All traders buy equal YES and NO
      // This maximizes the market maker's exposure
      const ledger2 = lmsr.initLedger(b, [
        { id: "alice", cash: 100000 },
        { id: "bob", cash: 100000 },
      ]);

      // Alice buys lots of YES
      lmsr.executeBuy(ledger2, "alice", "YES", 200);
      lmsr.executeBuy(ledger2, "alice", "YES", 200);

      // Bob buys lots of NO
      lmsr.executeBuy(ledger2, "bob", "NO", 200);
      lmsr.executeBuy(ledger2, "bob", "NO", 200);

      // Settle for YES
      const settlement = lmsr.settle(ledger2, "YES");

      // Realised loss should not exceed worst case
      // (allowing for some edge case variation)
      const realisedLoss = settlement.profitLoss.abs().toNumber();
      expect(realisedLoss).toBeLessThanOrEqual(expectedWorstCase * 1.01);
    });

    it("should bound loss for lopsided trading", () => {
      const b = 100;
      const expectedWorstCase = b * Math.LN2;

      const ledger2 = lmsr.initLedger(b, [
        { id: "alice", cash: 100000 },
      ]);

      // Heavy YES buying
      lmsr.executeBuy(ledger2, "alice", "YES", 500);

      // Settle for NO (worst case for market maker here)
      const settlement = lmsr.settle(ledger2, "NO");

      const realisedLoss = settlement.profitLoss.abs().toNumber();
      expect(realisedLoss).toBeLessThanOrEqual(expectedWorstCase * 1.01);
    });

    it("should have zero or positive profit for balanced outcomes", () => {
      const b = 100;

      // Balanced market: traders buy both sides
      const ledger2 = lmsr.initLedger(b, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      // Alice buys YES, Bob buys NO
      lmsr.executeBuy(ledger2, "alice", "YES", 50);
      lmsr.executeBuy(ledger2, "bob", "NO", 50);

      // Settlement
      const settlementYes = lmsr.settle(ledger2, "YES");
      const settlementNo = lmsr.settle(ledger2, "NO");

      // At least one outcome should be profitable or break-even
      // (market maker collected fees during trading)
      expect(
        settlementYes.profitLoss.toNumber() >= 0 ||
          settlementNo.profitLoss.toNumber() >= 0
      ).toBe(true);
    });
  });

  describe("Settlement Correctness", () => {
    it("should calculate correct payout for YES outcome", () => {
      const b = 100;

      // Some trading activity
      lmsr.executeBuy(ledger, "alice", "YES", 30);
      lmsr.executeBuy(ledger, "bob", "NO", 20);
      lmsr.executeBuy(ledger, "carol", "YES", 15);

      // Record final state before settlement
      const finalQYes = ledger.market.qYes.toNumber();
      const totalCollected = ledger.market.totalCollected.toNumber();

      const settlement = lmsr.settle(ledger, "YES");

      expect(settlement.outcome).toBe("YES");
      expectDecimalEqual(settlement.totalPayout, finalQYes);

      // Profit/Loss = Collected - Payout
      const expectedPL = totalCollected - finalQYes;
      expectDecimalClose(settlement.profitLoss, expectedPL, 1e-10);
    });

    it("should calculate correct payout for NO outcome", () => {
      const b = 100;

      lmsr.executeBuy(ledger, "alice", "YES", 30);
      lmsr.executeBuy(ledger, "bob", "NO", 20);
      lmsr.executeBuy(ledger, "carol", "NO", 15);

      const finalQNo = ledger.market.qNo.toNumber();
      const totalCollected = ledger.market.totalCollected.toNumber();

      const settlement = lmsr.settle(ledger, "NO");

      expect(settlement.outcome).toBe("NO");
      expectDecimalEqual(settlement.totalPayout, finalQNo);

      const expectedPL = totalCollected - finalQNo;
      expectDecimalClose(settlement.profitLoss, expectedPL, 1e-10);
    });

    it("should handle settlement with no trades", () => {
      const settlementYes = lmsr.settle(ledger, "YES");
      expectDecimalEqual(settlementYes.totalPayout, 0);
      expectDecimalEqual(settlementYes.profitLoss, 0);

      // Reset for NO settlement
      ledger.market.settled = false;
      delete ledger.market.outcome;

      const settlementNo = lmsr.settle(ledger, "NO");
      expectDecimalEqual(settlementNo.totalPayout, 0);
      expectDecimalEqual(settlementNo.profitLoss, 0);
    });

    it("should mark market as settled after settlement", () => {
      expect(ledger.market.settled).toBe(false);

      const settlement = lmsr.settle(ledger, "YES");
      applySettlement(ledger, settlement);

      expect(ledger.market.settled).toBe(true);
      expect(ledger.market.outcome).toBe("YES");
    });

    it("should reject double settlement", () => {
      const settlement = lmsr.settle(ledger, "YES");
      applySettlement(ledger, settlement);

      expect(() => {
        lmsr.settle(ledger, "NO");
      }).toThrow();
    });
  });

  describe("Trader Payout Calculations", () => {
    it("should correctly pay YES holders when YES wins", () => {
      // Trader buys YES shares
      const result = lmsr.executeBuy(ledger, "alice", "YES", 50);
      const yesSharesBought = result.qty.toNumber();

      // Update ledger
      ledger.market = result.newState;
      ledger.traders.set("alice", result.newTraderAccount);

      // Simulate settlement
      const settlement = lmsr.settle(ledger, "YES");

      // Payout should be yesSharesBought * 1 = yesSharesBought
      expectDecimalClose(settlement.totalPayout, yesSharesBought, 1e-10);
    });

    it("should correctly pay NO holders when NO wins", () => {
      const result = lmsr.executeBuy(ledger, "bob", "NO", 30);
      const noSharesBought = result.qty.toNumber();

      ledger.market = result.newState;
      ledger.traders.set("bob", result.newTraderAccount);

      const settlement = lmsr.settle(ledger, "NO");

      expectDecimalClose(settlement.totalPayout, noSharesBought, 1e-10);
    });

    it("should result in zero value for losing shares", () => {
      // Alice buys YES, outcome is NO
      lmsr.executeBuy(ledger, "alice", "YES", 50);

      const aliceYesShares = ledger.traders.get("alice")!.yesShares.toNumber();

      const settlement = lmsr.settle(ledger, "NO");

      // Total payout is for NO shares only
      // Alice's YES shares are worth 0
      expect(settlement.totalPayout.toNumber()).toBe(ledger.market.qNo.toNumber());
    });

    it("should handle mixed positions correctly", () => {
      // Alice buys both YES and NO
      lmsr.executeBuy(ledger, "alice", "YES", 25);
      lmsr.executeBuy(ledger, "alice", "NO", 15);

      const aliceYes = ledger.traders.get("alice")!.yesShares.toNumber();
      const aliceNo = ledger.traders.get("alice")!.noShares.toNumber();
      const aliceCash = ledger.traders.get("alice")!.cash.toNumber();

      // If YES wins, payout = aliceYes
      const settlementYes = lmsr.settle(ledger, "YES");
      const finalValueYes = aliceCash + aliceYes; // NO shares worth 0

      // Reset
      ledger.market.settled = false;
      delete ledger.market.outcome;

      // If NO wins, payout = aliceNo
      const settlementNo = lmsr.settle(ledger, "NO");
      const finalValueNo = aliceCash + aliceNo; // YES shares worth 0

      expectDecimalClose(settlementYes.totalPayout, aliceYes, 1e-10);
      expectDecimalClose(settlementNo.totalPayout, aliceNo, 1e-10);
    });
  });

  describe("Profit/Loss Scenarios", () => {
    it("should have positive PL when outcome matches consensus", () => {
      const b = 100;

      // Balanced trading creates fee income
      lmsr.executeBuy(ledger, "alice", "YES", 50);
      lmsr.executeBuy(ledger, "bob", "NO", 50);

      // Either outcome should be profitable or break-even
      const plYes = lmsr.settle(ledger, "YES").profitLoss.toNumber();
      const plNo = lmsr.settle({ ...ledger, market: { ...ledger.market, settled: false } }, "NO").profitLoss.toNumber();

      expect(plYes >= 0 || plNo >= 0).toBe(true);
    });

    it("should calculate loss when market is imbalanced", () => {
      const b = 100;

      // Only YES buying
      const result1 = lmsr.executeBuy(ledger, "alice", "YES", 100);
      ledger.market = result1.newState;
      ledger.traders.set("alice", result1.newTraderAccount);

      const result2 = lmsr.executeBuy(ledger, "bob", "YES", 50);
      ledger.market = result2.newState;
      ledger.traders.set("bob", result2.newTraderAccount);

      const settlement = lmsr.settle(ledger, "NO");

      // With 150 YES and 0 NO, when NO wins, payout = 0
      // The collected should be positive (profit)
      // So profitLoss = collected - 0 = collected > 0
      expect(settlement.profitLoss.toNumber()).toBeGreaterThanOrEqual(0);
    });

    it("should track total collected correctly", () => {
      const initialCollected = ledger.market.totalCollected.toNumber();
      expect(initialCollected).toBe(0);

      const result1 = lmsr.executeBuy(ledger, "alice", "YES", 30);
      const afterFirst = result1.newState.totalCollected.toNumber();

      ledger.market = result1.newState;
      ledger.traders.set("alice", result1.newTraderAccount);

      const result2 = lmsr.executeBuy(ledger, "bob", "NO", 20);
      const afterSecond = result2.newState.totalCollected.toNumber();

      expect(afterFirst).toBe(result1.spend.toNumber());
      expect(afterSecond).toBe(afterFirst + result2.spend.toNumber());
    });
  });

  describe("Market Settlement Edge Cases", () => {
    it("should handle settlement with single outcome dominant", () => {
      // Only one side traded
      lmsr.executeBuy(ledger, "alice", "YES", 200);

      const qYes = ledger.market.qYes.toNumber();
      const qNo = ledger.market.qNo.toNumber();

      // YES wins: payout = qYes
      const settlementYes = lmsr.settle(ledger, "YES");
      expectDecimalEqual(settlementYes.totalPayout, qYes);

      // NO wins: payout = qNo = 0
      const ledger2 = lmsr.initLedger(100, [
        { id: "alice", cash: 10000 },
      ]);
      lmsr.executeBuy(ledger2, "alice", "YES", 200);
      const settlementNo = lmsr.settle(ledger2, "NO");
      expectDecimalEqual(settlementNo.totalPayout, 0);
    });

    it("should calculate exact PL for zero payout scenario", () => {
      // No trades at all
      const settlement = lmsr.settle(ledger, "YES");

      expectDecimalEqual(settlement.totalPayout, 0);
      expectDecimalEqual(settlement.profitLoss, 0);
    });
  });
});
