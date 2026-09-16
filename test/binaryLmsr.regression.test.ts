/**
 * Determinism and Regression Tests for Binary LMSR
 *
 * Tests:
 * - Deterministic replay (same inputs → same outputs)
 * - Golden-run snapshots for critical scenarios
 * - Trade ID sequence consistency
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { BinaryLMSR, Ledger } from "../src/lib/binaryLmsr";

// The golden-master fixtures hold their values as STRINGS on purpose: a JSON
// number would round-trip through a float and lose the precision the whole
// suite exists to pin. Decimal accepts a string, so these helpers do too.
type DecimalLike = Decimal | number | string;

function expectDecimalClose(
  actual: DecimalLike,
  expected: DecimalLike,
  tolerance: number = 1e-10
): void {
  const a = actual instanceof Decimal ? actual : new Decimal(actual);
  const e = expected instanceof Decimal ? expected : new Decimal(expected);
  const diff = a.minus(e).abs().toNumber();
  expect(diff).toBeLessThanOrEqual(tolerance);
}

function expectDecimalEqual(
  actual: DecimalLike,
  expected: DecimalLike
): void {
  const a = actual instanceof Decimal ? actual : new Decimal(actual);
  const e = expected instanceof Decimal ? expected : new Decimal(expected);
  expect(a.toString()).toBe(e.toString());
}

interface GoldenSnapshot {
  scenario: string;
  b: number;
  trades: Array<{
    trader: string;
    outcome: "YES" | "NO";
    qty: number;
  }>;
  finalState: {
    qYes: string;
    qNo: string;
    totalCollected: string;
    pYES: string;
    pNO: string;
  };
  traderStates: Array<{
    trader: string;
    cash: string;
    yesShares: string;
    noShares: string;
  }>;
}

// Pre-computed golden snapshots for regression testing
const GOLDEN_SNAPSHOTS: GoldenSnapshot[] = [
  {
    scenario: "single_yes_trade",
    b: 100,
    trades: [
      { trader: "alice", outcome: "YES", qty: 50 },
    ],
    finalState: {
      qYes: "50",
      qNo: "0",
      totalCollected: "28.09298036201613714557652336",
      pYES: "0.6224593312018545646389005657",
      pNO: "0.3775406687981454353610994343",
    },
    traderStates: [
      {
        trader: "alice",
        cash: "9971.907019637983862854423477",
        yesShares: "50",
        noShares: "0",
      },
      {
        trader: "bob",
        cash: "10000",
        yesShares: "0",
        noShares: "0",
      },
    ],
  },
  {
    scenario: "single_no_trade",
    b: 100,
    trades: [
      { trader: "bob", outcome: "NO", qty: 30 },
    ],
    finalState: {
      qYes: "0",
      qNo: "30",
      totalCollected: "16.12080639085818093973563139",
      pYES: "0.4255574831883410128479287348",
      pNO: "0.5744425168116589871520712652",
    },
    traderStates: [
      {
        trader: "alice",
        cash: "10000",
        yesShares: "0",
        noShares: "0",
      },
      {
        trader: "bob",
        cash: "9983.879193609141819060264369",
        yesShares: "0",
        noShares: "30",
      },
    ],
  },
  {
    scenario: "balanced_trades",
    b: 100,
    trades: [
      { trader: "alice", outcome: "YES", qty: 50 },
      { trader: "bob", outcome: "NO", qty: 50 },
    ],
    finalState: {
      qYes: "50",
      qNo: "50",
      totalCollected: "50.00000000000000000000000005",
      pYES: "0.5",
      pNO: "0.5",
    },
    traderStates: [
      {
        trader: "alice",
        cash: "9971.907019637983862854423477",
        yesShares: "50",
        noShares: "0",
      },
      {
        trader: "bob",
        cash: "9978.092980362016137145576523",
        yesShares: "0",
        noShares: "50",
      },
    ],
  },
  {
    scenario: "multiple_small_trades",
    b: 100,
    trades: [
      { trader: "alice", outcome: "YES", qty: 10 },
      { trader: "alice", outcome: "YES", qty: 15 },
      { trader: "bob", outcome: "NO", qty: 20 },
      { trader: "alice", outcome: "NO", qty: 5 },
    ],
    finalState: {
      qYes: "25",
      qNo: "25",
      totalCollected: "25",
      pYES: "0.5",
      pNO: "0.5",
    },
    traderStates: [
      {
        trader: "alice",
        cash: "9984.252022813444273194405034",
        yesShares: "25",
        noShares: "5",
      },
      {
        trader: "bob",
        cash: "9990.747977186555726805594966",
        yesShares: "0",
        noShares: "20",
      },
    ],
  },
  {
    scenario: "bullish_shift",
    b: 100,
    trades: [
      { trader: "alice", outcome: "YES", qty: 100 },
      { trader: "alice", outcome: "YES", qty: 50 },
      { trader: "bob", outcome: "YES", qty: 30 },
    ],
    finalState: {
      qYes: "180",
      qNo: "0",
      totalCollected: "125.9830429966128825182144742",
      pYES: "0.8581489350995122104057218918",
      pNO: "0.1418510649004877895942781082",
    },
    traderStates: [
      {
        trader: "alice",
        cash: "9899.173390257719289991774932",
        yesShares: "150",
        noShares: "0",
      },
      {
        trader: "bob",
        cash: "9974.843566745667827490010595",
        yesShares: "30",
        noShares: "0",
      },
    ],
  },
];

describe("BinaryLMSR: Determinism and Regression", () => {
  let lmsr: BinaryLMSR;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
  });

  describe("Deterministic Replay", () => {
    it("should produce identical results for same trade sequence", () => {
      const trades = [
        { trader: "alice", outcome: "YES" as const, qty: 25 },
        { trader: "bob", outcome: "NO" as const, qty: 15 },
        { trader: "alice", outcome: "NO" as const, qty: 10 },
      ];

      // First run
      const ledger1 = lmsr.initLedger(100, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of trades) {
        const result = lmsr.executeBuy(ledger1, trade.trader, trade.outcome, trade.qty);
        ledger1.market = result.newState;
        ledger1.traders.set(trade.trader, result.newTraderAccount);
      }

      // Second run
      const ledger2 = lmsr.initLedger(100, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of trades) {
        const result = lmsr.executeBuy(ledger2, trade.trader, trade.outcome, trade.qty);
        ledger2.market = result.newState;
        ledger2.traders.set(trade.trader, result.newTraderAccount);
      }

      // States should be identical
      expectDecimalEqual(ledger1.market.qYes, ledger2.market.qYes);
      expectDecimalEqual(ledger1.market.qNo, ledger2.market.qNo);
      expectDecimalEqual(ledger1.market.totalCollected, ledger2.market.totalCollected);

      for (const traderId of ["alice", "bob"]) {
        const t1 = ledger1.traders.get(traderId)!;
        const t2 = ledger2.traders.get(traderId)!;

        expectDecimalEqual(t1.cash, t2.cash);
        expectDecimalEqual(t1.yesShares, t2.yesShares);
        expectDecimalEqual(t1.noShares, t2.noShares);
      }
    });

    it("should produce identical trade IDs for same sequence", () => {
      // Create two fresh LMSR instances
      const lmsr1 = new BinaryLMSR();
      const lmsr2 = new BinaryLMSR();

      const trades = [
        { trader: "alice", outcome: "YES" as const, qty: 10 },
        { trader: "bob", outcome: "NO" as const, qty: 15 },
      ];

      const ledger1 = lmsr1.initLedger(100, [{ id: "alice", cash: 10000 }, { id: "bob", cash: 10000 }]);
      const ledger2 = lmsr2.initLedger(100, [{ id: "alice", cash: 10000 }, { id: "bob", cash: 10000 }]);

      const ids1: string[] = [];
      const ids2: string[] = [];

      for (const trade of trades) {
        const result1 = lmsr1.executeBuy(ledger1, trade.trader, trade.outcome, trade.qty);
        ids1.push(result1.tradeId);
        ledger1.market = result1.newState;
        ledger1.traders.set(trade.trader, result1.newTraderAccount);

        const result2 = lmsr2.executeBuy(ledger2, trade.trader, trade.outcome, trade.qty);
        ids2.push(result2.tradeId);
        ledger2.market = result2.newState;
        ledger2.traders.set(trade.trader, result2.newTraderAccount);
      }

      // IDs should be identical (both start from 00000001)
      expect(ids1).toEqual(ids2);
    });

    it("should produce same results across different b values with proportional trades", () => {
      const b1 = 100;
      const b2 = 200;

      // Trade sequence 1
      const ledger1 = lmsr.initLedger(b1, [{ id: "alice", cash: 10000 }]);
      const result1 = lmsr.executeBuy(ledger1, "alice", "YES", 50);

      // Trade sequence 2 with double b and double qty (should give similar prices)
      const ledger2 = lmsr.initLedger(b2, [{ id: "alice", cash: 10000 }]);
      const result2 = lmsr.executeBuy(ledger2, "alice", "YES", 100);

      // Prices should be similar (since q/b ratio is same)
      const prices1 = lmsr.getPrices(result1.newState);
      const prices2 = lmsr.getPrices(result2.newState);

      expectDecimalEqual(prices1.pYES, prices2.pYES);
    });
  });

  describe("Golden Master Snapshots", () => {
    it("should match golden snapshot: single_yes_trade", () => {
      const scenario = GOLDEN_SNAPSHOTS[0];
      const ledger = lmsr.initLedger(scenario.b, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of scenario.trades) {
        const result = lmsr.executeBuy(ledger, trade.trader, trade.outcome, trade.qty);
        // Update ledger state after trade
        ledger.market = result.newState;
        ledger.traders.set(trade.trader, result.newTraderAccount);
      }

      // Check final state
      expectDecimalEqual(ledger.market.qYes, scenario.finalState.qYes);
      expectDecimalEqual(ledger.market.qNo, scenario.finalState.qNo);
      expectDecimalClose(ledger.market.totalCollected, scenario.finalState.totalCollected, 1e-9);

      const prices = lmsr.getPrices(ledger.market);
      expectDecimalClose(prices.pYES, scenario.finalState.pYES, 1e-15);
      expectDecimalClose(prices.pNO, scenario.finalState.pNO, 1e-15);

      // Check trader states
      for (const expectedTrader of scenario.traderStates) {
        const trader = ledger.traders.get(expectedTrader.trader)!;
        expectDecimalClose(trader.cash, expectedTrader.cash, 1e-9);
        expectDecimalEqual(trader.yesShares, expectedTrader.yesShares);
        expectDecimalEqual(trader.noShares, expectedTrader.noShares);
      }
    });

    it("should match golden snapshot: single_no_trade", () => {
      const scenario = GOLDEN_SNAPSHOTS[1];
      const ledger = lmsr.initLedger(scenario.b, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of scenario.trades) {
        const result = lmsr.executeBuy(ledger, trade.trader, trade.outcome, trade.qty);
        ledger.market = result.newState;
        ledger.traders.set(trade.trader, result.newTraderAccount);
      }

      expectDecimalEqual(ledger.market.qYes, scenario.finalState.qYes);
      expectDecimalEqual(ledger.market.qNo, scenario.finalState.qNo);
      expectDecimalClose(ledger.market.totalCollected, scenario.finalState.totalCollected, 1e-9);

      const prices = lmsr.getPrices(ledger.market);
      expectDecimalClose(prices.pYES, scenario.finalState.pYES, 1e-15);
      expectDecimalClose(prices.pNO, scenario.finalState.pNO, 1e-15);
    });

    it("should match golden snapshot: balanced_trades", () => {
      const scenario = GOLDEN_SNAPSHOTS[2];
      const ledger = lmsr.initLedger(scenario.b, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of scenario.trades) {
        const result = lmsr.executeBuy(ledger, trade.trader, trade.outcome, trade.qty);
        ledger.market = result.newState;
        ledger.traders.set(trade.trader, result.newTraderAccount);
      }

      // Price should be exactly 0.5
      const prices = lmsr.getPrices(ledger.market);
      expectDecimalEqual(prices.pYES, new Decimal(0.5));
      expectDecimalEqual(prices.pNO, new Decimal(0.5));

      // Check final state
      expectDecimalEqual(ledger.market.qYes, scenario.finalState.qYes);
      expectDecimalEqual(ledger.market.qNo, scenario.finalState.qNo);
      expectDecimalClose(ledger.market.totalCollected, scenario.finalState.totalCollected, 1e-8);

      // Check trader states
      for (const expectedTrader of scenario.traderStates) {
        const trader = ledger.traders.get(expectedTrader.trader)!;
        expectDecimalClose(trader.cash, expectedTrader.cash, 1e-9);
        expectDecimalEqual(trader.yesShares, expectedTrader.yesShares);
        expectDecimalEqual(trader.noShares, expectedTrader.noShares);
      }
    });

    it("should match golden snapshot: multiple_small_trades", () => {
      const scenario = GOLDEN_SNAPSHOTS[3];
      const ledger = lmsr.initLedger(scenario.b, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of scenario.trades) {
        const result = lmsr.executeBuy(ledger, trade.trader, trade.outcome, trade.qty);
        ledger.market = result.newState;
        ledger.traders.set(trade.trader, result.newTraderAccount);
      }

      expectDecimalEqual(ledger.market.qYes, scenario.finalState.qYes);
      expectDecimalEqual(ledger.market.qNo, scenario.finalState.qNo);

      for (const expectedTrader of scenario.traderStates) {
        const trader = ledger.traders.get(expectedTrader.trader)!;
        expectDecimalClose(trader.cash, expectedTrader.cash, 1e-9);
        expectDecimalEqual(trader.yesShares, expectedTrader.yesShares);
        expectDecimalEqual(trader.noShares, expectedTrader.noShares);
      }
    });

    it("should match golden snapshot: bullish_shift", () => {
      const scenario = GOLDEN_SNAPSHOTS[4];
      const ledger = lmsr.initLedger(scenario.b, [
        { id: "alice", cash: 10000 },
        { id: "bob", cash: 10000 },
      ]);

      for (const trade of scenario.trades) {
        const result = lmsr.executeBuy(ledger, trade.trader, trade.outcome, trade.qty);
        ledger.market = result.newState;
        ledger.traders.set(trade.trader, result.newTraderAccount);
      }

      // Check final state
      expectDecimalEqual(ledger.market.qYes, scenario.finalState.qYes);
      expectDecimalEqual(ledger.market.qNo, scenario.finalState.qNo);

      const prices = lmsr.getPrices(ledger.market);
      expectDecimalClose(prices.pYES, scenario.finalState.pYES, 1e-14);
      expectDecimalClose(prices.pNO, scenario.finalState.pNO, 1e-14);

      expectDecimalClose(ledger.market.totalCollected, scenario.finalState.totalCollected, 1e-9);

      // Check trader states
      for (const expectedTrader of scenario.traderStates) {
        const trader = ledger.traders.get(expectedTrader.trader)!;
        expectDecimalClose(trader.cash, expectedTrader.cash, 1e-9);
        expectDecimalEqual(trader.yesShares, expectedTrader.yesShares);
        expectDecimalEqual(trader.noShares, expectedTrader.noShares);
      }
    });
  });

  describe("Trade ID Sequence", () => {
    it("should generate sequential trade IDs", () => {
      const ledger = lmsr.initLedger(100, [{ id: "alice", cash: 10000 }]);

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const result = lmsr.executeBuy(ledger, "alice", "YES", 10);
        ids.push(result.tradeId);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);
      }

      // Extract numeric parts
      const nums = ids.map((id) => parseInt(id.replace("TRD-", "")));

      // Should be sequential
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i]).toBe(nums[i - 1] + 1);
      }
    });

    it("should reset trade ID counter for new LMSR instance", () => {
      const lmsr1 = new BinaryLMSR();
      const ledger1 = lmsr1.initLedger(100, [{ id: "alice", cash: 10000 }]);
      const result1 = lmsr1.executeBuy(ledger1, "alice", "YES", 10);
      const id1 = result1.tradeId;

      const lmsr2 = new BinaryLMSR();
      const ledger2 = lmsr2.initLedger(100, [{ id: "alice", cash: 10000 }]);
      const result2 = lmsr2.executeBuy(ledger2, "alice", "YES", 10);
      const id2 = result2.tradeId;

      expect(id1).toBe(id2); // Both should be TRD-00000001
    });
  });

  describe("Quote Determinism", () => {
    it("should produce deterministic quotes for same state", () => {
      const b = 100;
      const ledger = lmsr.initLedger(b, [{ id: "alice", cash: 10000 }]);

      // Do some trades
      lmsr.executeBuy(ledger, "alice", "YES", 50);
      lmsr.executeBuy(ledger, "alice", "NO", 30);

      // Get quotes multiple times
      const quotes1 = lmsr.quoteQtyBuy(ledger.market, "YES", 10);
      const quotes2 = lmsr.quoteQtyBuy(ledger.market, "YES", 10);
      const quotes3 = lmsr.quoteQtyBuy(ledger.market, "YES", 10);

      expectDecimalEqual(quotes1.payment, quotes2.payment);
      expectDecimalEqual(quotes2.payment, quotes3.payment);
      expectDecimalEqual(quotes1.avgPrice, quotes2.avgPrice);
      expectDecimalEqual(quotes1.qty, quotes2.qty);
    });

    it("should produce deterministic spend quotes", () => {
      const b = 100;
      const ledger = lmsr.initLedger(b, [{ id: "alice", cash: 10000 }]);

      lmsr.executeBuy(ledger, "alice", "YES", 50);

      const spend = 100;
      const quote1 = lmsr.quoteSpendBuy(ledger.market, "YES", spend);
      const quote2 = lmsr.quoteSpendBuy(ledger.market, "YES", spend);

      expectDecimalEqual(quote1.qty, quote2.qty);
      expectDecimalEqual(quote1.spend, quote2.spend);
    });
  });

  describe("Price Time Series Regression", () => {
    it("should have consistent price evolution for trade sequence", () => {
      const trades = [
        { outcome: "YES" as const, qty: 10 },
        { outcome: "YES" as const, qty: 20 },
        { outcome: "NO" as const, qty: 15 },
      ];

      const ledger = lmsr.initLedger(100, [{ id: "alice", cash: 10000 }]);

      const prices: Array<{ pYES: string; pNO: string }> = [];

      for (const trade of trades) {
        const result = lmsr.executeBuy(ledger, "alice", trade.outcome, trade.qty);
        ledger.market = result.newState;
        ledger.traders.set("alice", result.newTraderAccount);

        const currentPrices = lmsr.getPrices(ledger.market);
        prices.push({
          pYES: currentPrices.pYES.toString(),
          pNO: currentPrices.pNO.toString(),
        });
      }

      // Verify deterministic behavior - same sequence should give same results
      const ledger2 = lmsr.initLedger(100, [{ id: "alice", cash: 10000 }]);

      for (const trade of trades) {
        const result = lmsr.executeBuy(ledger2, "alice", trade.outcome, trade.qty);
        ledger2.market = result.newState;
        ledger2.traders.set("alice", result.newTraderAccount);

        const currentPrices = lmsr.getPrices(ledger2.market);
        expectDecimalEqual(currentPrices.pYES, prices[trades.indexOf(trade)].pYES as any);
      }
    });
  });
});
