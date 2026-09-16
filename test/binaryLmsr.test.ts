/**
 * Comprehensive tests for BinaryLMSR implementation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  BinaryLMSR,
  LMSRLogger,
  Outcome,
  MarketState,
  TraderAccount,
  Ledger,
  QuoteQty,
  QuoteSpend,
  ExecutionResult,
  SettlementResult,
  decimalToNumber,
  applyExecution,
  applySettlement,
  lmsr,
} from "../src/lib/binaryLmsr";

// Tolerance for floating point comparisons
const EPSILON = 1e-10;
const TOLERANCE = 1e-9;

// Helper to compare Decimals
function expectDecimalClose(actual: Decimal, expected: Decimal, tolerance = TOLERANCE): void {
  const diff = actual.minus(expected).abs().toNumber();
  expect(diff).toBeLessThan(tolerance);
}

// Helper to compare Decimal to number
function expectDecimalCloseToNumber(actual: Decimal, expected: number, tolerance = TOLERANCE): void {
  expectDecimalClose(actual, new Decimal(expected), tolerance);
}

describe("BinaryLMSR", () => {
  let lmsr: BinaryLMSR;

  beforeEach(() => {
    lmsr = new BinaryLMSR();
  });

  describe("Price Properties", () => {
    describe("Prices are always in [0,1] and sum to 1", () => {
      it("p_YES = p_NO = 0.5 at origin", () => {
        const state = lmsr.initMarket(100);
        const prices = lmsr.getPrices(state);

        expectDecimalCloseToNumber(prices.pYES, 0.5, EPSILON);
        expectDecimalCloseToNumber(prices.pNO, 0.5, EPSILON);
        expectDecimalCloseToNumber(prices.pYES.plus(prices.pNO), 1.0, EPSILON);
      });

      it("prices stay in [0,1] for extreme quantities", () => {
        const state = lmsr.initMarket(100);

        // Test with large YES quantities
        const yesHeavyState: MarketState = {
          ...state,
          qYes: new Decimal(1000),
          qNo: new Decimal(0),
        };
        const yesHeavyPrices = lmsr.getPrices(yesHeavyState);
        expect(yesHeavyPrices.pYES.toNumber()).toBeGreaterThan(0);
        expect(yesHeavyPrices.pYES.toNumber()).toBeLessThan(1);
        expect(yesHeavyPrices.pNO.toNumber()).toBeGreaterThan(0);
        expect(yesHeavyPrices.pNO.toNumber()).toBeLessThan(1);
        expectDecimalCloseToNumber(yesHeavyPrices.pYES.plus(yesHeavyPrices.pNO), 1.0, EPSILON);

        // Test with large NO quantities
        const noHeavyState: MarketState = {
          ...state,
          qYes: new Decimal(0),
          qNo: new Decimal(1000),
        };
        const noHeavyPrices = lmsr.getPrices(noHeavyState);
        expect(noHeavyPrices.pYES.toNumber()).toBeGreaterThan(0);
        expect(noHeavyPrices.pYES.toNumber()).toBeLessThan(1);
        expect(noHeavyPrices.pNO.toNumber()).toBeGreaterThan(0);
        expect(noHeavyPrices.pNO.toNumber()).toBeLessThan(1);
        expectDecimalCloseToNumber(noHeavyPrices.pYES.plus(noHeavyPrices.pNO), 1.0, EPSILON);
      });

      it("prices sum to 1 for various states", () => {
        const b = 50;
        const testStates = [
          { qYes: 0, qNo: 0 },
          { qYes: 10, qNo: 0 },
          { qYes: 0, qNo: 10 },
          { qYes: 10, qNo: 10 },
          { qYes: 25.5, qNo: 17.3 },
          { qYes: 100, qNo: 50 },
          { qYes: 1.5, qNo: 99.5 },
        ];

        for (const quantities of testStates) {
          const state: MarketState = {
            qYes: new Decimal(quantities.qYes),
            qNo: new Decimal(quantities.qNo),
            b: new Decimal(b),
            totalCollected: new Decimal(0),
            settled: false,
          };
          const prices = lmsr.getPrices(state);
          const sum = prices.pYES.plus(prices.pNO).toNumber();
          expect(sum).toBeCloseTo(1.0, 9);
        }
      });
    });

    describe("Buying YES increases p_YES; buying NO increases p_NO", () => {
      it("p_YES increases when buying YES", () => {
        const state = lmsr.initMarket(100);
        const pricesBefore = lmsr.getPrices(state);

        const quote = lmsr.quoteQtyBuy(state, "YES", 10);
        const pricesAfter = quote.pricesAfter;

        expect(pricesAfter.yes.toNumber()).toBeGreaterThan(pricesBefore.pYES.toNumber());
      });

      it("p_NO increases when buying NO", () => {
        const state = lmsr.initMarket(100);
        const pricesBefore = lmsr.getPrices(state);

        const quote = lmsr.quoteQtyBuy(state, "NO", 10);
        const pricesAfter = quote.pricesAfter;

        expect(pricesAfter.no.toNumber()).toBeGreaterThan(pricesBefore.pNO.toNumber());
      });

      it("p_YES increases monotonically with more YES purchases", () => {
        const state = lmsr.initMarket(100);
        const prices = lmsr.getPrices(state);
        let prevPrice = prices.pYES.toNumber();

        for (const qty of [1, 5, 10, 20, 50]) {
          const quote = lmsr.quoteQtyBuy(state, "YES", qty);
          const newPrice = quote.pricesAfter.yes.toNumber();
          expect(newPrice).toBeGreaterThan(prevPrice);
          prevPrice = newPrice;
        }
      });

      it("p_NO increases monotonically with more NO purchases", () => {
        const state = lmsr.initMarket(100);
        const prices = lmsr.getPrices(state);
        let prevPrice = prices.pNO.toNumber();

        for (const qty of [1, 5, 10, 20, 50]) {
          const quote = lmsr.quoteQtyBuy(state, "NO", qty);
          const newPrice = quote.pricesAfter.no.toNumber();
          expect(newPrice).toBeGreaterThan(prevPrice);
          prevPrice = newPrice;
        }
      });
    });
  });

  describe("Cost Properties", () => {
    describe("Cost is convex/monotonic (dC > 0 for dq > 0)", () => {
      it("payment is positive for any positive quantity", () => {
        const state = lmsr.initMarket(100);

        for (const qty of [0.1, 1, 5, 10, 50, 100]) {
          const quote = lmsr.quoteQtyBuy(state, "YES", qty);
          expect(quote.payment.toNumber()).toBeGreaterThan(0);
        }
      });

      it("cost increases with quantity", () => {
        const state = lmsr.initMarket(100);
        let prevCost = lmsr.cost(state).toNumber();

        const quantities = [1, 5, 10, 20, 50];
        for (const qty of quantities) {
          const newState: MarketState = {
            ...state,
            qYes: state.qYes.plus(new Decimal(qty)),
          };
          const newCost = lmsr.cost(newState).toNumber();
          expect(newCost).toBeGreaterThan(prevCost);
          prevCost = newCost;
        }
      });

      it("cost for 5 shares > cost for 1 share", () => {
        const state = lmsr.initMarket(100);

        const quote1 = lmsr.quoteQtyBuy(state, "YES", 1);
        const quote5 = lmsr.quoteQtyBuy(state, "YES", 5);

        expect(quote5.payment.toNumber()).toBeGreaterThan(quote1.payment.toNumber());
      });
    });
  });

  describe("Round-trip sanity", () => {
    it("quoting then executing yields exactly quoted spend/qty within tolerance", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      // Test quoteQtyBuy -> executeBuy round trip
      const quote = lmsr.quoteQtyBuy(ledger.market, "YES", 10);
      const execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);

      expectDecimalClose(execution.spend, quote.payment, EPSILON);
      expectDecimalClose(execution.qty, quote.qty, EPSILON);
      expectDecimalClose(execution.avgPrice, quote.avgPrice, EPSILON);
    });

    it("average price from execution matches quote average price", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      const quote = lmsr.quoteQtyBuy(ledger.market, "NO", 5);
      const execution = lmsr.executeBuy(ledger, "trader1", "NO", 5);

      expectDecimalClose(execution.avgPrice, quote.avgPrice, EPSILON);
    });

    it("spend-based quote yields correct quantity on execution", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      const spend = new Decimal(25);
      const quote = lmsr.quoteSpendBuy(ledger.market, "YES", spend);
      const execution = lmsr.executeBuySpend(ledger, "trader1", "YES", spend);

      expectDecimalClose(execution.qty, quote.qty, EPSILON);
      expectDecimalClose(execution.spend, quote.spend, EPSILON);
    });
  });

  describe("Determinism", () => {
    it("same initial state + same sequence of trades -> identical final state + logs", () => {
      const b = 100;
      const ledger1 = lmsr.initLedger(b, [
        { id: "trader1", cash: 500 },
        { id: "trader2", cash: 500 },
      ]);
      const ledger2 = lmsr.initLedger(b, [
        { id: "trader1", cash: 500 },
        { id: "trader2", cash: 500 },
      ]);

      const logger1 = new LMSRLogger();
      const logger2 = new LMSRLogger();

      // Execute same trades on both
      const trades = [
        { trader: "trader1", outcome: "YES" as Outcome, qty: 10 },
        { trader: "trader2", outcome: "NO" as Outcome, qty: 5 },
        { trader: "trader1", outcome: "YES" as Outcome, qty: 3 },
      ];

      for (const trade of trades) {
        const result1 = lmsr.executeBuy(ledger1, trade.trader, trade.outcome, trade.qty);
        const result2 = lmsr.executeBuy(ledger2, trade.trader, trade.outcome, trade.qty);

        logger1.logTradeExecuted(result1);
        logger2.logTradeExecuted(result2);

        applyExecution(ledger1, result1);
        applyExecution(ledger2, result2);
      }

      // Check final states are identical
      expectDecimalClose(ledger1.market.qYes, ledger2.market.qYes, EPSILON);
      expectDecimalClose(ledger1.market.qNo, ledger2.market.qNo, EPSILON);
      expectDecimalClose(ledger1.market.totalCollected, ledger2.market.totalCollected, EPSILON);

      // Check logs are identical (same number of entries)
      expect(logger1.getLogs().length).toBe(logger2.getLogs().length);
    });

    it("two markets with same trades end up with same final state", () => {
      const lmsr1 = new BinaryLMSR();
      const lmsr2 = new BinaryLMSR();

      const ledger1 = lmsr1.initLedger(50, [
        { id: "alice", cash: 1000 },
      ]);
      const ledger2 = lmsr2.initLedger(50, [
        { id: "alice", cash: 1000 },
      ]);

      const trades = [
        { outcome: "YES" as Outcome, qty: 15 },
        { outcome: "NO" as Outcome, qty: 8 },
        { outcome: "YES" as Outcome, qty: 12 },
      ];

      for (const trade of trades) {
        const result1 = lmsr1.executeBuy(ledger1, "alice", trade.outcome, trade.qty);
        const result2 = lmsr2.executeBuy(ledger2, "alice", trade.outcome, trade.qty);
        applyExecution(ledger1, result1);
        applyExecution(ledger2, result2);
      }

      expectDecimalClose(ledger1.market.qYes, ledger2.market.qYes, EPSILON);
      expectDecimalClose(ledger1.market.qNo, ledger2.market.qNo, EPSILON);
    });
  });

  describe("API: getPrices", () => {
    it("returns prices as Decimal objects", () => {
      const state = lmsr.initMarket(100);
      const prices = lmsr.getPrices(state);

      expect(prices.pYES).toBeInstanceOf(Decimal);
      expect(prices.pNO).toBeInstanceOf(Decimal);
    });

    it("returns prices with correct precision", () => {
      const state = lmsr.initMarket(100);
      const prices = lmsr.getPrices(state);

      expect(prices.pYES.toString()).toBeDefined();
      expect(prices.pNO.toString()).toBeDefined();
      expect(prices.pYES.plus(prices.pNO).toNumber()).toBeCloseTo(1, 9);
    });
  });

  describe("API: cost", () => {
    it("returns cost as Decimal", () => {
      const state = lmsr.initMarket(100);
      const cost = lmsr.cost(state);

      expect(cost).toBeInstanceOf(Decimal);
      expect(cost.toNumber()).toBeGreaterThanOrEqual(0);
    });

    it("cost at origin is b * ln(2)", () => {
      const b = 100;
      const state = lmsr.initMarket(b);
      const cost = lmsr.cost(state);

      expectDecimalCloseToNumber(cost, b * Math.LN2, 1e-9);
    });
  });

  describe("API: quoteQtyBuy", () => {
    it("returns payment, avgPrice, qty, outcome, pricesBefore, pricesAfter", () => {
      const state = lmsr.initMarket(100);
      const quote: QuoteQty = lmsr.quoteQtyBuy(state, "YES", 10);

      expect(quote.payment).toBeInstanceOf(Decimal);
      expect(quote.avgPrice).toBeInstanceOf(Decimal);
      expect(quote.qty).toBeInstanceOf(Decimal);
      expect(quote.outcome).toBe("YES");
      expect(quote.pricesBefore.yes).toBeInstanceOf(Decimal);
      expect(quote.pricesBefore.no).toBeInstanceOf(Decimal);
      expect(quote.pricesAfter.yes).toBeInstanceOf(Decimal);
      expect(quote.pricesAfter.no).toBeInstanceOf(Decimal);
    });

    it("calculates average price correctly", () => {
      const state = lmsr.initMarket(100);
      const qty = 10;
      const quote = lmsr.quoteQtyBuy(state, "YES", qty);

      const expectedAvgPrice = quote.payment.div(qty);
      expectDecimalClose(quote.avgPrice, expectedAvgPrice, EPSILON);
    });

    it("throws error for settled market", () => {
      const state: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(0),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: true,
        outcome: "YES",
      };

      expect(() => lmsr.quoteQtyBuy(state, "YES", 10)).toThrow("Cannot quote in settled market");
    });

    it("throws error for non-positive quantity", () => {
      const state = lmsr.initMarket(100);

      expect(() => lmsr.quoteQtyBuy(state, "YES", 0)).toThrow("Quantity must be positive");
      expect(() => lmsr.quoteQtyBuy(state, "YES", -1)).toThrow("Quantity must be positive");
    });
  });

  describe("API: quoteSpendBuy", () => {
    it("finds quantity where cost ~ spend using binary search", () => {
      const state = lmsr.initMarket(100);
      const spend = new Decimal(25);
      const quote: QuoteSpend = lmsr.quoteSpendBuy(state, "YES", spend);

      // The binary search finds max qty where cost <= spend
      // Actual spend should be <= requested spend
      expect(quote.spend.toNumber()).toBeLessThanOrEqual(spend.toNumber());
      // And should use most of the spend (within reasonable bounds)
      expect(quote.spend.toNumber()).toBeGreaterThan(spend.toNumber() * 0.5);
    });

    it("returns reasonable quantity for given spend", () => {
      const state = lmsr.initMarket(100);
      const spend = 20;
      const quote = lmsr.quoteSpendBuy(state, "YES", spend);

      expect(quote.qty.toNumber()).toBeGreaterThan(0);
      expect(quote.spend.toNumber()).toBeGreaterThan(0);
      expect(quote.spend.toNumber()).toBeLessThanOrEqual(spend * 1.01); // Allow small tolerance
    });

    it("returns all required fields", () => {
      const state = lmsr.initMarket(100);
      const quote: QuoteSpend = lmsr.quoteSpendBuy(state, "NO", 15);

      expect(quote.qty).toBeInstanceOf(Decimal);
      expect(quote.avgPrice).toBeInstanceOf(Decimal);
      expect(quote.spend).toBeInstanceOf(Decimal);
      expect(quote.outcome).toBe("NO");
      expect(quote.pricesBefore.yes).toBeInstanceOf(Decimal);
      expect(quote.pricesBefore.no).toBeInstanceOf(Decimal);
      expect(quote.pricesAfter.yes).toBeInstanceOf(Decimal);
      expect(quote.pricesAfter.no).toBeInstanceOf(Decimal);
    });

    it("throws error for settled market", () => {
      const state: MarketState = {
        qYes: new Decimal(0),
        qNo: new Decimal(0),
        b: new Decimal(100),
        totalCollected: new Decimal(0),
        settled: true,
        outcome: "YES",
      };

      expect(() => lmsr.quoteSpendBuy(state, "YES", 10)).toThrow("Cannot quote in settled market");
    });

    it("throws error for non-positive spend", () => {
      const state = lmsr.initMarket(100);

      expect(() => lmsr.quoteSpendBuy(state, "YES", 0)).toThrow("Spend must be positive");
      expect(() => lmsr.quoteSpendBuy(state, "YES", -1)).toThrow("Spend must be positive");
    });
  });

  describe("API: executeBuy - Ledger integration", () => {
    it("debits trader cash by exact payment", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);
      const traderBefore = ledger.traders.get("trader1")!;
      const cashBefore = traderBefore.cash;

      const execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      applyExecution(ledger, execution);

      const traderAfter = ledger.traders.get("trader1")!;
      const cashAfter = traderAfter.cash;

      expectDecimalClose(cashBefore.minus(cashAfter), execution.spend, EPSILON);
    });

    it("credits trader shares by exact quantity", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      const execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      applyExecution(ledger, execution);

      const trader = ledger.traders.get("trader1")!;
      expectDecimalClose(trader.yesShares, execution.qty, EPSILON);
      expectDecimalClose(trader.noShares, new Decimal(0), EPSILON);
    });

    it("updates market totalCollected", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);
      const totalCollectedBefore = ledger.market.totalCollected;

      const execution = lmsr.executeBuy(ledger, "trader1", "NO", 5);
      applyExecution(ledger, execution);

      const expectedTotal = totalCollectedBefore.plus(execution.spend);
      expectDecimalClose(ledger.market.totalCollected, expectedTotal, EPSILON);
    });

    it("throws error for insufficient cash", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 5 },
      ]);

      expect(() => lmsr.executeBuy(ledger, "trader1", "YES", 100)).toThrow("Insufficient cash");
    });

    it("throws error for non-positive quantity", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      expect(() => lmsr.executeBuy(ledger, "trader1", "YES", 0)).toThrow("Quantity must be positive");
      expect(() => lmsr.executeBuy(ledger, "trader1", "YES", -1)).toThrow("Quantity must be positive");
    });

    it("throws error for non-existent trader", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      expect(() => lmsr.executeBuy(ledger, "nonexistent", "YES", 10)).toThrow("not found");
    });

    it("throws error for settled market", () => {
      const ledger: Ledger = {
        market: {
          qYes: new Decimal(0),
          qNo: new Decimal(0),
          b: new Decimal(100),
          totalCollected: new Decimal(0),
          settled: true,
          outcome: "YES",
        },
        traders: new Map([["trader1", lmsr.initTrader("trader1", 1000)]]),
      };

      expect(() => lmsr.executeBuy(ledger, "trader1", "YES", 10)).toThrow("Cannot trade in settled market");
    });
  });

  describe("API: executeBuySpend", () => {
    it("executes trade based on spend amount", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);
      const spend = 25;

      const execution = lmsr.executeBuySpend(ledger, "trader1", "YES", spend);
      applyExecution(ledger, execution);

      const trader = ledger.traders.get("trader1")!;

      // Cash should be debited by actual spend (close to requested spend)
      expectDecimalCloseToNumber(trader.cash, 1000 - execution.spend.toNumber(), 1e-9);
      expect(execution.qty.toNumber()).toBeGreaterThan(0);
    });

    it("throws error for insufficient cash", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 5 },
      ]);

      expect(() => lmsr.executeBuySpend(ledger, "trader1", "YES", 100)).toThrow("Insufficient cash");
    });
  });

  describe("API: settle", () => {
    it("calculates correct payout for YES outcome", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      // Execute some trades to create outstanding shares
      let execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      applyExecution(ledger, execution);
      execution = lmsr.executeBuy(ledger, "trader1", "NO", 5);
      applyExecution(ledger, execution);

      const settlement: SettlementResult = lmsr.settle(ledger, "YES");

      expect(settlement.outcome).toBe("YES");
      expectDecimalClose(settlement.totalPayout, ledger.market.qYes, EPSILON);
      expect(settlement.profitLoss).toBeInstanceOf(Decimal);
    });

    it("calculates correct payout for NO outcome", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      let execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      applyExecution(ledger, execution);
      execution = lmsr.executeBuy(ledger, "trader1", "NO", 5);
      applyExecution(ledger, execution);

      const settlement: SettlementResult = lmsr.settle(ledger, "NO");

      expect(settlement.outcome).toBe("NO");
      expectDecimalClose(settlement.totalPayout, ledger.market.qNo, EPSILON);
    });

    it("calculates profit/loss correctly", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      let execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      applyExecution(ledger, execution);

      const totalCollected = ledger.market.totalCollected;
      const settlement = lmsr.settle(ledger, "YES");

      // Profit = totalCollected - payout
      const expectedProfit = totalCollected.minus(settlement.totalPayout);
      expectDecimalClose(settlement.profitLoss, expectedProfit, EPSILON);
    });

    it("throws error for already settled market", () => {
      const ledger: Ledger = {
        market: {
          qYes: new Decimal(10),
          qNo: new Decimal(5),
          b: new Decimal(100),
          totalCollected: new Decimal(50),
          settled: true,
          outcome: "YES",
        },
        traders: new Map([["trader1", lmsr.initTrader("trader1", 1000)]]),
      };

      expect(() => lmsr.settle(ledger, "YES")).toThrow("Market already settled");
    });
  });

  describe("API: worstCaseLoss", () => {
    it("returns b * ln(2)", () => {
      const b = 100;
      const worstLoss = lmsr.worstCaseLoss(b);

      expectDecimalCloseToNumber(worstLoss, b * Math.LN2, 1e-9);
    });

    it("accepts Decimal parameter", () => {
      const b = new Decimal(50);
      const worstLoss = lmsr.worstCaseLoss(b);

      expectDecimalCloseToNumber(worstLoss, 50 * Math.LN2, 1e-9);
    });

    it("returns correct value for various b values", () => {
      const bValues = [1, 10, 50, 100, 500];

      for (const b of bValues) {
        const worstLoss = lmsr.worstCaseLoss(b);
        expectDecimalCloseToNumber(worstLoss, b * Math.LN2, 1e-9);
      }
    });
  });

  describe("LMSRLogger", () => {
    let logger: LMSRLogger;

    beforeEach(() => {
      logger = new LMSRLogger();
    });

    it("logs and retrieves events correctly", () => {
      const state = lmsr.initMarket(100);
      const quote = lmsr.quoteQtyBuy(state, "YES", 10);

      logger.logQuote(quote);
      const logs = logger.getLogs();

      expect(logs.length).toBe(1);
      expect(logs[0].type).toBe("QUOTE");
      expect("data" in logs[0]).toBe(true);
      expect("timestamp" in logs[0]).toBe(true);
    });

    it("logs different event types", () => {
      const state = lmsr.initMarket(100);
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      // Log quote
      const quote = lmsr.quoteQtyBuy(state, "YES", 10);
      logger.logQuote(quote);

      // Log trade
      const execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      logger.logTradeExecuted(execution);

      // Log state
      logger.logStateSnapshot(state);

      // Log settlement
      const settlement = lmsr.settle(ledger, "YES");
      logger.logSettlement(settlement);

      const logs = logger.getLogs();
      expect(logs.length).toBe(4);
      expect(logs[0].type).toBe("QUOTE");
      expect(logs[1].type).toBe("TRADE_EXECUTED");
      expect(logs[2].type).toBe("STATE_SNAPSHOT");
      expect(logs[3].type).toBe("SETTLEMENT");
    });

    it("export logs as JSON contains expected data", () => {
      const state = lmsr.initMarket(100);
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      const quote = lmsr.quoteQtyBuy(state, "YES", 10);
      logger.logQuote(quote);

      const execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
      logger.logTradeExecuted(execution);

      const jsonOutput = logger.exportJson();
      const parsedLogs = JSON.parse(jsonOutput);

      expect(Array.isArray(parsedLogs)).toBe(true);
      expect(parsedLogs.length).toBe(2);
      expect(parsedLogs[0]).toHaveProperty("type");
      expect(parsedLogs[0]).toHaveProperty("data");
      expect(parsedLogs[0]).toHaveProperty("timestamp");
      expect(parsedLogs[0].type).toBe("QUOTE");
    });

    it("clear removes all logs", () => {
      const state = lmsr.initMarket(100);
      const quote = lmsr.quoteQtyBuy(state, "YES", 10);

      logger.logQuote(quote);
      expect(logger.getLogs().length).toBe(1);

      logger.clear();
      expect(logger.getLogs().length).toBe(0);
    });
  });

  describe("Helper functions", () => {
    describe("decimalToNumber", () => {
      it("converts Decimal to number correctly", () => {
        const d = new Decimal("123.456");
        const num = decimalToNumber(d);

        expect(typeof num).toBe("number");
        expect(num).toBeCloseTo(123.456, 9);
      });

      it("handles small decimals", () => {
        const d = new Decimal("0.0001");
        const num = decimalToNumber(d);

        expect(num).toBeCloseTo(0.0001, 9);
      });

      it("handles large decimals", () => {
        const d = new Decimal("1000000.5");
        const num = decimalToNumber(d);

        expect(num).toBe(1000000.5);
      });
    });

    describe("applyExecution", () => {
      it("updates ledger correctly", () => {
        const ledger = lmsr.initLedger(100, [
          { id: "trader1", cash: 1000 },
        ]);

        const execution = lmsr.executeBuy(ledger, "trader1", "YES", 10);
        const updatedLedger = applyExecution(ledger, execution);

        expect(updatedLedger).toBe(ledger); // Returns same reference
        expectDecimalClose(updatedLedger.market.qYes, new Decimal(10), EPSILON);
        expectDecimalClose(updatedLedger.market.totalCollected, execution.spend, EPSILON);

        const trader = updatedLedger.traders.get("trader1")!;
        expectDecimalClose(trader.yesShares, execution.qty, EPSILON);
        expectDecimalClose(trader.cash, new Decimal(1000).minus(execution.spend), EPSILON);
      });

      it("updates multiple traders correctly", () => {
        const ledger = lmsr.initLedger(100, [
          { id: "alice", cash: 1000 },
          { id: "bob", cash: 500 },
        ]);

        let execution = lmsr.executeBuy(ledger, "alice", "YES", 10);
        applyExecution(ledger, execution);

        execution = lmsr.executeBuy(ledger, "bob", "NO", 5);
        applyExecution(ledger, execution);

        const alice = ledger.traders.get("alice")!;
        const bob = ledger.traders.get("bob")!;

        expectDecimalClose(alice.yesShares, new Decimal(10), EPSILON);
        expectDecimalClose(bob.noShares, new Decimal(5), EPSILON);
        expectDecimalClose(ledger.market.qYes, new Decimal(10), EPSILON);
        expectDecimalClose(ledger.market.qNo, new Decimal(5), EPSILON);
      });
    });

    describe("applySettlement", () => {
      it("updates ledger with settlement", () => {
        const ledger = lmsr.initLedger(100, [
          { id: "trader1", cash: 1000 },
        ]);

        const settlement = lmsr.settle(ledger, "YES");
        const updatedLedger = applySettlement(ledger, settlement);

        expect(updatedLedger).toBe(ledger); // Returns same reference
        expect(updatedLedger.market.settled).toBe(true);
        expect(updatedLedger.market.outcome).toBe("YES");
      });

      it("prevents trading after settlement", () => {
        const ledger = lmsr.initLedger(100, [
          { id: "trader1", cash: 1000 },
        ]);

        const settlement = lmsr.settle(ledger, "YES");
        applySettlement(ledger, settlement);

        expect(() => lmsr.executeBuy(ledger, "trader1", "YES", 10)).toThrow("Cannot trade in settled market");
      });
    });
  });

  describe("Edge cases and additional scenarios", () => {
    it("handles Decimal inputs correctly", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      const execution = lmsr.executeBuy(ledger, "trader1", "YES", new Decimal("10.5"));
      applyExecution(ledger, execution);

      const trader = ledger.traders.get("trader1")!;
      expectDecimalClose(trader.yesShares, new Decimal("10.5"), EPSILON);
    });

    it("cloneState creates independent copy", () => {
      const original = lmsr.initMarket(100);
      const clone = lmsr.cloneState(original);

      // Modify clone
      clone.qYes = new Decimal(999);

      // Original should be unchanged
      expectDecimalClose(original.qYes, new Decimal(0), EPSILON);
      expect(clone.qYes.toNumber()).toBe(999);
    });

    it("cloneTrader creates independent copy", () => {
      const original = lmsr.initTrader("trader1", 1000);
      const clone = lmsr.cloneTrader(original);

      // Modify clone
      clone.cash = new Decimal(0);

      // Original should be unchanged
      expectDecimalClose(original.cash, new Decimal(1000), EPSILON);
      expect(clone.cash.toNumber()).toBe(0);
    });

    it("throws error for non-positive b parameter", () => {
      expect(() => lmsr.initMarket(0)).toThrow("Liquidity parameter b must be positive");
      expect(() => lmsr.initMarket(-10)).toThrow("Liquidity parameter b must be positive");
    });

    it("handles multiple trades by same trader", () => {
      const ledger = lmsr.initLedger(100, [
        { id: "trader1", cash: 1000 },
      ]);

      const trades = [
        { outcome: "YES" as Outcome, qty: 5 },
        { outcome: "NO" as Outcome, qty: 3 },
        { outcome: "YES" as Outcome, qty: 8 },
      ];

      for (const trade of trades) {
        const execution = lmsr.executeBuy(ledger, "trader1", trade.outcome, trade.qty);
        applyExecution(ledger, execution);
      }

      const trader = ledger.traders.get("trader1")!;
      expectDecimalClose(trader.yesShares, new Decimal(13), EPSILON); // 5 + 8
      expectDecimalClose(trader.noShares, new Decimal(3), EPSILON);
      expectDecimalClose(ledger.market.qYes, new Decimal(13), EPSILON);
      expectDecimalClose(ledger.market.qNo, new Decimal(3), EPSILON);
    });
  });

  describe("Price movement behavior", () => {
    it("price converges to 1 as quantity imbalance increases", () => {
      const b = 100;
      const state = lmsr.initMarket(b);

      // Buy increasingly large amounts of YES
      let lastPrice = 0.5;
      for (const qty of [10, 50, 100, 200, 500, 1000]) {
        const testState: MarketState = {
          ...state,
          qYes: new Decimal(qty),
          qNo: new Decimal(0),
        };
        const prices = lmsr.getPrices(testState);
        const currentPrice = prices.pYES.toNumber();

        expect(currentPrice).toBeGreaterThan(lastPrice);
        expect(currentPrice).toBeLessThan(1);
        lastPrice = currentPrice;
      }
    });

    it("price approaches 0.5 from both sides with balanced quantities", () => {
      const b = 100;

      for (const qty of [0, 10, 50, 100]) {
        const state: MarketState = {
          qYes: new Decimal(qty),
          qNo: new Decimal(qty),
          b: new Decimal(b),
          totalCollected: new Decimal(0),
          settled: false,
        };
        const prices = lmsr.getPrices(state);

        expectDecimalCloseToNumber(prices.pYES, 0.5, EPSILON);
        expectDecimalCloseToNumber(prices.pNO, 0.5, EPSILON);
      }
    });
  });

  describe("Exported singleton", () => {
    it("lmsr singleton is functional", () => {
      const state = lmsr.initMarket(100);
      const prices = lmsr.getPrices(state);

      expect(prices.pYES).toBeInstanceOf(Decimal);
      expect(prices.pNO).toBeInstanceOf(Decimal);
      expectDecimalCloseToNumber(prices.pYES, 0.5, EPSILON);
    });
  });
});
