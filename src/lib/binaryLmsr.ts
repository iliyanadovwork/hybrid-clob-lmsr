/**
 * Binary LMSR (Logarithmic Market Scoring Rule) - Full Simulator Module
 *
 * Complete implementation with:
 * - Public API matching simulator design
 * - Quote functions (qty-based and spend-based with binary search solver)
 * - Ledger integration with trader accounts
 * - Structured logging (QUOTE, TRADE_EXECUTED, STATE_SNAPSHOT)
 * - Deterministic behavior
 */

import { Decimal } from "decimal.js";

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -28,
  toExpPos: 28,
});

export type Outcome = "YES" | "NO";

export interface MarketState {
  qYes: Decimal;
  qNo: Decimal;
  b: Decimal;
  totalCollected: Decimal;
  settled: boolean;
  outcome?: Outcome;
}

export interface TraderAccount {
  traderId: string;
  cash: Decimal;
  yesShares: Decimal;
  noShares: Decimal;
}

export interface Ledger {
  market: MarketState;
  traders: Map<string, TraderAccount>;
}

export interface QuoteQty {
  payment: Decimal;
  avgPrice: Decimal;
  qty: Decimal;
  outcome: Outcome;
  pricesBefore: { yes: Decimal; no: Decimal };
  pricesAfter: { yes: Decimal; no: Decimal };
}

export interface QuoteSpend {
  qty: Decimal;
  avgPrice: Decimal;
  spend: Decimal;
  outcome: Outcome;
  pricesBefore: { yes: Decimal; no: Decimal };
  pricesAfter: { yes: Decimal; no: Decimal };
}

export interface ExecutionResult {
  tradeId: string;
  traderId: string;
  outcome: Outcome;
  qty: Decimal;
  spend: Decimal;
  avgPrice: Decimal;
  pricesBefore: { yes: Decimal; no: Decimal };
  pricesAfter: { yes: Decimal; no: Decimal };
  timestamp: string;
  newState: MarketState;
  newTraderAccount: TraderAccount;
}

export interface SettlementResult {
  outcome: Outcome;
  totalPayout: Decimal;
  profitLoss: Decimal;
  timestamp: string;
}

export type LogEntry =
  | { type: "QUOTE"; data: QuoteQty | QuoteSpend; timestamp: string }
  | { type: "TRADE_EXECUTED"; data: ExecutionResult; timestamp: string }
  | { type: "STATE_SNAPSHOT"; data: MarketState; timestamp: string }
  | { type: "SETTLEMENT"; data: SettlementResult; timestamp: string };

const SOLVER_TOLERANCE = new Decimal("1e-12");
const MAX_SOLVER_ITERATIONS = 100;

export class BinaryLMSR {
  private readonly LN2: Decimal;
  private readonly ZERO: Decimal;
  private readonly ONE: Decimal;
  private tradeCounter: number = 0;

  constructor() {
    this.LN2 = new Decimal(Math.LN2);
    this.ZERO = new Decimal(0);
    this.ONE = new Decimal(1);
  }

  initMarket(b: number | Decimal): MarketState {
    const bD = b instanceof Decimal ? b : new Decimal(b);
    if (bD.lte(0)) {
      throw new Error("Liquidity parameter b must be positive");
    }
    return {
      qYes: this.ZERO,
      qNo: this.ZERO,
      b: bD,
      totalCollected: this.ZERO,
      settled: false,
    };
  }

  initTrader(traderId: string, initialCash: number | Decimal = 0): TraderAccount {
    return {
      traderId,
      cash: initialCash instanceof Decimal ? initialCash : new Decimal(initialCash),
      yesShares: this.ZERO,
      noShares: this.ZERO,
    };
  }

  initLedger(b: number, traders: Array<{ id: string; cash: number }>): Ledger {
    const market = this.initMarket(b);
    const traderMap = new Map<string, TraderAccount>();
    for (const t of traders) {
      traderMap.set(t.id, this.initTrader(t.id, t.cash));
    }
    return { market, traders: traderMap };
  }

  getPrices(state: MarketState): { pYES: Decimal; pNO: Decimal } {
    const pYes = this._priceYes(state);
    return { pYES: pYes, pNO: this.ONE.minus(pYes) };
  }

  cost(state: MarketState): Decimal {
    return this._cost(state);
  }

  quoteQtyBuy(state: MarketState, outcome: Outcome, qty: number | Decimal): QuoteQty {
    if (state.settled) {
      throw new Error("Cannot quote in settled market");
    }
    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);
    if (qtyD.lte(0)) {
      throw new Error("Quantity must be positive");
    }

    const pricesBefore = this.getPrices(state);
    const costBefore = this._cost(state);

    const qYesAfter = outcome === "YES" ? state.qYes.plus(qtyD) : state.qYes;
    const qNoAfter = outcome === "NO" ? state.qNo.plus(qtyD) : state.qNo;
    const stateAfter: MarketState = { ...state, qYes: qYesAfter, qNo: qNoAfter };

    const costAfter = this._cost(stateAfter);
    const payment = costAfter.minus(costBefore);
    const avgPrice = qtyD.gt(0) ? payment.div(qtyD) : this.ZERO;

    const pricesAfter = this.getPrices(stateAfter);

    return {
      payment,
      avgPrice,
      qty: qtyD,
      outcome,
      pricesBefore: { yes: pricesBefore.pYES, no: pricesBefore.pNO },
      pricesAfter: { yes: pricesAfter.pYES, no: pricesAfter.pNO },
    };
  }

  quoteSpendBuy(state: MarketState, outcome: Outcome, spend: number | Decimal): QuoteSpend {
    if (state.settled) {
      throw new Error("Cannot quote in settled market");
    }
    const spendD = spend instanceof Decimal ? spend : new Decimal(spend);
    if (spendD.lte(0)) {
      throw new Error("Spend must be positive");
    }

    const pricesBefore = this.getPrices(state);

    let minQty = this.ZERO;
    let maxQty = spendD;
    let foundQty = this.ZERO;
    let iterations = 0;

    const minCheck = this._computeDeltaC(state, outcome, new Decimal("1e-10"));
    if (minCheck.gt(spendD)) {
      const pricesAfter = this.getPrices(state);
      return {
        qty: this.ZERO,
        avgPrice: this.ZERO,
        spend: spendD,
        outcome,
        pricesBefore: { yes: pricesBefore.pYES, no: pricesBefore.pNO },
        pricesAfter: { yes: pricesAfter.pYES, no: pricesAfter.pNO },
      };
    }

    while (iterations < MAX_SOLVER_ITERATIONS) {
      iterations++;
      const midQty = minQty.plus(maxQty.minus(minQty).div(new Decimal(2)));
      const deltaC = this._computeDeltaC(state, outcome, midQty);

      if (deltaC.lte(spendD)) {
        foundQty = midQty;
        minQty = midQty;
      } else {
        maxQty = midQty;
      }

      const range = maxQty.minus(minQty);
      if (range.lt(SOLVER_TOLERANCE)) {
        break;
      }

      const newDeltaC = this._computeDeltaC(state, outcome, foundQty);
      if (newDeltaC.minus(spendD).abs().lt(SOLVER_TOLERANCE)) {
        break;
      }
    }

    const actualDeltaC = this._computeDeltaC(state, outcome, foundQty);
    const avgPrice = foundQty.gt(0) ? actualDeltaC.div(foundQty) : this.ZERO;

    const qYesAfter = outcome === "YES" ? state.qYes.plus(foundQty) : state.qYes;
    const qNoAfter = outcome === "NO" ? state.qNo.plus(foundQty) : state.qNo;
    const stateAfter: MarketState = { ...state, qYes: qYesAfter, qNo: qNoAfter };
    const pricesAfter = this.getPrices(stateAfter);

    return {
      qty: foundQty,
      avgPrice,
      spend: actualDeltaC,
      outcome,
      pricesBefore: { yes: pricesBefore.pYES, no: pricesBefore.pNO },
      pricesAfter: { yes: pricesAfter.pYES, no: pricesAfter.pNO },
    };
  }

  quoteQtySell(state: MarketState, outcome: Outcome, qty: number | Decimal): QuoteQty {
    if (state.settled) {
      throw new Error("Cannot quote in settled market");
    }
    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);
    if (qtyD.lte(0)) {
      throw new Error("Quantity must be positive");
    }

    const outstanding = outcome === "YES" ? state.qYes : state.qNo;
    if (qtyD.gt(outstanding)) {
      throw new Error(
        "Cannot sell " + qtyD.toString() + " " + outcome +
        " shares: only " + outstanding.toString() + " outstanding in market"
      );
    }

    const pricesBefore = this.getPrices(state);
    const costBefore = this._cost(state);

    const qYesAfter = outcome === "YES" ? state.qYes.minus(qtyD) : state.qYes;
    const qNoAfter = outcome === "NO" ? state.qNo.minus(qtyD) : state.qNo;
    const stateAfter: MarketState = { ...state, qYes: qYesAfter, qNo: qNoAfter };

    const costAfter = this._cost(stateAfter);
    const receipt = costBefore.minus(costAfter);
    const avgPrice = qtyD.gt(0) ? receipt.div(qtyD) : this.ZERO;

    const pricesAfter = this.getPrices(stateAfter);

    return {
      payment: receipt,
      avgPrice,
      qty: qtyD,
      outcome,
      pricesBefore: { yes: pricesBefore.pYES, no: pricesBefore.pNO },
      pricesAfter: { yes: pricesAfter.pYES, no: pricesAfter.pNO },
    };
  }

  executeSell(
    ledger: Ledger,
    traderId: string,
    outcome: Outcome,
    qty: number | Decimal,
  ): ExecutionResult {
    if (ledger.market.settled) {
      throw new Error("Cannot trade in settled market");
    }

    const trader = ledger.traders.get(traderId);
    if (!trader) {
      throw new Error("Trader " + traderId + " not found");
    }

    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);
    if (qtyD.lte(0)) {
      throw new Error("Quantity must be positive");
    }

    const traderShares = outcome === "YES" ? trader.yesShares : trader.noShares;
    if (qtyD.gt(traderShares)) {
      throw new Error(
        "Insufficient " + outcome + " shares: need " + qtyD.toString() +
        ", have " + traderShares.toString()
      );
    }

    const quote = this.quoteQtySell(ledger.market, outcome, qtyD);
    const receipt = quote.payment;

    const updatedTrader: TraderAccount = {
      ...trader,
      cash: trader.cash.plus(receipt),
      yesShares: outcome === "YES" ? trader.yesShares.minus(qtyD) : trader.yesShares,
      noShares: outcome === "NO" ? trader.noShares.minus(qtyD) : trader.noShares,
    };

    if (updatedTrader.yesShares.lt(0) || updatedTrader.noShares.lt(0)) {
      throw new Error("Accounting error: trader shares would be negative");
    }

    const qYesAfter = outcome === "YES" ? ledger.market.qYes.minus(qtyD) : ledger.market.qYes;
    const qNoAfter = outcome === "NO" ? ledger.market.qNo.minus(qtyD) : ledger.market.qNo;
    const newTotalCollected = ledger.market.totalCollected.minus(receipt);

    if (qYesAfter.lt(0) || qNoAfter.lt(0)) {
      throw new Error("Accounting error: market outstanding shares would be negative");
    }

    const updatedMarket: MarketState = {
      ...ledger.market,
      qYes: qYesAfter,
      qNo: qNoAfter,
      totalCollected: newTotalCollected,
    };

    this.tradeCounter++;
    const tradeId = "TRD-" + this.tradeCounter.toString().padStart(8, "0");
    const timestamp = new Date().toISOString();

    return {
      tradeId,
      traderId,
      outcome,
      qty: qtyD,
      spend: receipt,
      avgPrice: quote.avgPrice,
      pricesBefore: quote.pricesBefore,
      pricesAfter: quote.pricesAfter,
      timestamp,
      newState: updatedMarket,
      newTraderAccount: updatedTrader,
    };
  }

  executeBuy(
    ledger: Ledger,
    traderId: string,
    outcome: Outcome,
    qty: number | Decimal,
  ): ExecutionResult {
    if (ledger.market.settled) {
      throw new Error("Cannot trade in settled market");
    }

    const trader = ledger.traders.get(traderId);
    if (!trader) {
      throw new Error("Trader " + traderId + " not found");
    }

    const qtyD = qty instanceof Decimal ? qty : new Decimal(qty);
    if (qtyD.lte(0)) {
      throw new Error("Quantity must be positive");
    }

    const quote = this.quoteQtyBuy(ledger.market, outcome, qtyD);
    const payment = quote.payment;

    if (payment.gt(trader.cash)) {
      throw new Error("Insufficient cash: need " + payment.toString() + ", have " + trader.cash.toString());
    }

    const updatedTrader: TraderAccount = {
      ...trader,
      cash: trader.cash.minus(payment),
      yesShares: outcome === "YES" ? trader.yesShares.plus(qtyD) : trader.yesShares,
      noShares: outcome === "NO" ? trader.noShares.plus(qtyD) : trader.noShares,
    };

    if (updatedTrader.cash.lt(0)) {
      throw new Error("Accounting error: cash would be negative");
    }

    const qYesAfter = outcome === "YES" ? ledger.market.qYes.plus(qtyD) : ledger.market.qYes;
    const qNoAfter = outcome === "NO" ? ledger.market.qNo.plus(qtyD) : ledger.market.qNo;
    const newTotalCollected = ledger.market.totalCollected.plus(payment);

    const updatedMarket: MarketState = {
      ...ledger.market,
      qYes: qYesAfter,
      qNo: qNoAfter,
      totalCollected: newTotalCollected,
    };

    this.tradeCounter++;
    const tradeId = "TRD-" + this.tradeCounter.toString().padStart(8, "0");
    const timestamp = new Date().toISOString();

    return {
      tradeId,
      traderId,
      outcome,
      qty: qtyD,
      spend: payment,
      avgPrice: quote.avgPrice,
      pricesBefore: quote.pricesBefore,
      pricesAfter: quote.pricesAfter,
      timestamp,
      newState: updatedMarket,
      newTraderAccount: updatedTrader,
    };
  }

  executeBuySpend(
    ledger: Ledger,
    traderId: string,
    outcome: Outcome,
    spend: number | Decimal,
  ): ExecutionResult {
    if (ledger.market.settled) {
      throw new Error("Cannot trade in settled market");
    }

    const trader = ledger.traders.get(traderId);
    if (!trader) {
      throw new Error("Trader " + traderId + " not found");
    }

    const spendD = spend instanceof Decimal ? spend : new Decimal(spend);
    if (spendD.lte(0)) {
      throw new Error("Spend must be positive");
    }

    if (spendD.gt(trader.cash)) {
      throw new Error("Insufficient cash: need " + spendD.toString() + ", have " + trader.cash.toString());
    }

    const quote = this.quoteSpendBuy(ledger.market, outcome, spendD);
    const actualQty = quote.qty;
    const actualSpend = quote.spend;

    const updatedTrader: TraderAccount = {
      ...trader,
      cash: trader.cash.minus(actualSpend),
      yesShares: outcome === "YES" ? trader.yesShares.plus(actualQty) : trader.yesShares,
      noShares: outcome === "NO" ? trader.noShares.plus(actualQty) : trader.noShares,
    };

    if (updatedTrader.cash.lt(0)) {
      throw new Error("Accounting error: cash would be negative");
    }

    const qYesAfter = outcome === "YES" ? ledger.market.qYes.plus(actualQty) : ledger.market.qYes;
    const qNoAfter = outcome === "NO" ? ledger.market.qNo.plus(actualQty) : ledger.market.qNo;
    const newTotalCollected = ledger.market.totalCollected.plus(actualSpend);

    const updatedMarket: MarketState = {
      ...ledger.market,
      qYes: qYesAfter,
      qNo: qNoAfter,
      totalCollected: newTotalCollected,
    };

    this.tradeCounter++;
    const tradeId = "TRD-" + this.tradeCounter.toString().padStart(8, "0");
    const timestamp = new Date().toISOString();

    return {
      tradeId,
      traderId,
      outcome,
      qty: actualQty,
      spend: actualSpend,
      avgPrice: quote.avgPrice,
      pricesBefore: quote.pricesBefore,
      pricesAfter: quote.pricesAfter,
      timestamp,
      newState: updatedMarket,
      newTraderAccount: updatedTrader,
    };
  }

  settle(ledger: Ledger, outcome: Outcome): SettlementResult {
    if (ledger.market.settled) {
      throw new Error("Market already settled");
    }

    const timestamp = new Date().toISOString();
    const totalPayout = outcome === "YES" ? ledger.market.qYes : ledger.market.qNo;
    const profitLoss = ledger.market.totalCollected.minus(totalPayout);

    return {
      outcome,
      totalPayout,
      profitLoss,
      timestamp,
    };
  }

  private _cost(state: MarketState): Decimal {
    const { qYes, qNo, b } = state;
    const x = qYes.div(b);
    const y = qNo.div(b);
    const max = x.gte(y) ? x : y;
    const diff1 = x.minus(max);
    const diff2 = y.minus(max);
    const sumExp = diff1.exp().plus(diff2.exp());
    return max.plus(sumExp.ln()).times(b);
  }

  private _priceYes(state: MarketState): Decimal {
    const { qYes, qNo, b } = state;
    const diff = qNo.minus(qYes).div(b);
    return this.ONE.plus(diff.exp()).pow(-1);
  }

  private _computeDeltaC(state: MarketState, outcome: Outcome, deltaQ: Decimal): Decimal {
    const qYesAfter = outcome === "YES" ? state.qYes.plus(deltaQ) : state.qYes;
    const qNoAfter = outcome === "NO" ? state.qNo.plus(deltaQ) : state.qNo;

    const before: MarketState = { ...state, qYes: state.qYes, qNo: state.qNo };
    const after: MarketState = { ...state, qYes: qYesAfter, qNo: qNoAfter };

    return this._cost(after).minus(this._cost(before));
  }

  worstCaseLoss(b: number | Decimal): Decimal {
    const bD = b instanceof Decimal ? b : new Decimal(b);
    return bD.times(this.LN2);
  }

  cloneState(state: MarketState): MarketState {
    return {
      qYes: new Decimal(state.qYes.toString()),
      qNo: new Decimal(state.qNo.toString()),
      b: new Decimal(state.b.toString()),
      totalCollected: new Decimal(state.totalCollected.toString()),
      settled: state.settled,
      outcome: state.outcome,
    };
  }

  cloneTrader(trader: TraderAccount): TraderAccount {
    return {
      traderId: trader.traderId,
      cash: new Decimal(trader.cash.toString()),
      yesShares: new Decimal(trader.yesShares.toString()),
      noShares: new Decimal(trader.noShares.toString()),
    };
  }
}

export const lmsr = new BinaryLMSR();

export class LMSRLogger {
  private logs: LogEntry[] = [];

  logQuote(quote: QuoteQty | QuoteSpend): void {
    const timestamp = new Date().toISOString();
    this.logs.push({ type: "QUOTE", data: quote, timestamp });
  }

  logTradeExecuted(execution: ExecutionResult): void {
    this.logs.push({
      type: "TRADE_EXECUTED",
      data: execution,
      timestamp: execution.timestamp,
    });
  }

  logStateSnapshot(state: MarketState): void {
    this.logs.push({
      type: "STATE_SNAPSHOT",
      data: state,
      timestamp: new Date().toISOString(),
    });
  }

  logSettlement(settlement: SettlementResult): void {
    this.logs.push({
      type: "SETTLEMENT",
      data: settlement,
      timestamp: settlement.timestamp,
    });
  }

  getLogs(): readonly LogEntry[] {
    return this.logs;
  }

  exportJson(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  clear(): void {
    this.logs = [];
  }
}

export function decimalToNumber(d: Decimal): number {
  return d.toNumber();
}

export function formatDecimal(d: Decimal, decimals = 6): string {
  return d.toDecimalPlaces(decimals).toString();
}

export function applyExecution(ledger: Ledger, execution: ExecutionResult): Ledger {
  ledger.market = execution.newState;
  ledger.traders.set(execution.traderId, execution.newTraderAccount);
  return ledger;
}

export function applySettlement(ledger: Ledger, settlement: SettlementResult): Ledger {
  (ledger.market as any).settled = true;
  (ledger.market as any).outcome = settlement.outcome;
  return ledger;
}
