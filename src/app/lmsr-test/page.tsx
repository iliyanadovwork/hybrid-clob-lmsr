"use client";

import { useState, useEffect } from "react";
import { Decimal } from "decimal.js";
import {
  BinaryLMSR,
  Ledger,
  MarketState,
  TraderAccount,
  Outcome,
  QuoteQty,
  QuoteSpend,
} from "@/lib/binaryLmsr";

// Simple chart component for cost curve
function CostCurveChart({
  b,
  qYes,
  qNo,
}: {
  b: number;
  qYes: number;
  qNo: number;
}) {
  const points = 50;
  const maxQ = Math.max(qYes, qNo, 10) * 1.5;
  const minPrice = 0.01;
  const maxPrice = 0.99;

  // Generate cost curve data points
  const generateCurve = () => {
    const data: { x: number; y: number; cost: number }[] = [];
    for (let i = 0; i <= points; i++) {
      const q = (i / points) * maxQ;
      // Calculate price at this qYes level
      const price = 1 / (1 + Math.exp((qNo - q) / b));
      data.push({ x: q, y: price, cost: 0 });
    }
    return data;
  };

  const curve = generateCurve();
  const currentPrice = 1 / (1 + Math.exp((qNo - qYes) / b));

  // Get SVG path coordinates
  const width = 100;
  const height = 100;
  const padding = 5;

  const getX = (q: number) => padding + (q / maxQ) * (width - 2 * padding);
  const getY = (price: number) => height - padding - ((price - minPrice) / (maxPrice - minPrice)) * (height - 2 * padding);

  const pathD = curve
    .map((p, i) => {
      const cmd = i === 0 ? "M" : "L";
      return `${cmd} ${getX(p.x)} ${getY(p.y)}`;
    })
    .join(" ");

  return (
    <div className="relative w-full h-full">
      <svg viewBox="0 0 100 100" className="w-full h-full">
        {/* Grid lines */}
        <line x1={padding} y1={getY(0.5)} x2={width - padding} y2={getY(0.5)} stroke="#e5e7eb" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1={padding} y1={getY(0.25)} x2={width - padding} y2={getY(0.25)} stroke="#e5e7eb" strokeWidth="0.5" strokeDasharray="2,2" />
        <line x1={padding} y1={getY(0.75)} x2={width - padding} y2={getY(0.75)} stroke="#e5e7eb" strokeWidth="0.5" strokeDasharray="2,2" />

        {/* Cost curve */}
        <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth="1.5" />

        {/* Current state point */}
        <circle cx={getX(qYes)} cy={getY(currentPrice)} r="2" fill="#ef4444" />
        <circle cx={getX(qYes)} cy={getY(currentPrice)} r="4" fill="none" stroke="#ef4444" strokeWidth="0.5" />

        {/* Current qYes line */}
        <line x1={getX(qYes)} y1={getY(currentPrice)} x2={getX(qYes)} y2={height - padding} stroke="#ef4444" strokeWidth="0.5" strokeDasharray="2,2" />

        {/* Labels */}
        <text x={padding} y={padding + 2} fontSize="2" fill="#6b7280">P=1.0</text>
        <text x={padding} y={height - padding} fontSize="2" fill="#6b7280">P=0</text>
        <text x={width - padding - 5} y={height - padding} fontSize="2" fill="#6b7280" textAnchor="end">Q</text>
      </svg>

      {/* Legend */}
      <div className="absolute top-0 right-0 bg-white/90 dark:bg-gray-800/90 p-2 rounded text-xs">
        <div className="flex items-center gap-1 mb-1">
          <div className="w-3 h-0.5 bg-blue-500"></div>
          <span className="text-gray-600 dark:text-gray-400">Cost Curve</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-red-500"></div>
          <span className="text-gray-600 dark:text-gray-400">Current</span>
        </div>
      </div>
    </div>
  );
}

// Price impact chart
function PriceImpactChart({
  b,
  qYes,
  qNo,
}: {
  b: number;
  qYes: number;
  qNo: number;
}) {
  const trades = [1, 5, 10, 20, 50, 100];
  const maxTrade = Math.max(...trades);
  const maxImpact = 0.5;

  const calculateImpact = (qty: number) => {
    const priceBefore = 1 / (1 + Math.exp((qNo - qYes) / b));
    const priceAfter = 1 / (1 + Math.exp((qNo - (qYes + qty)) / b));
    return priceAfter - priceBefore;
  };

  const getWidth = (qty: number) => {
    const impact = Math.abs(calculateImpact(qty));
    return Math.min((impact / maxImpact) * 100, 100);
  };

  return (
    <div className="space-y-2">
      {trades.map((trade) => {
        const impact = calculateImpact(trade);
        const width = getWidth(trade);
        const isPositive = impact >= 0;

        return (
          <div key={trade} className="flex items-center gap-2 text-xs">
            <span className="w-12 text-right text-gray-500">{trade} YES</span>
            <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
              <div
                className={`h-full transition-all ${isPositive ? "bg-green-500" : "bg-red-500"}`}
                style={{ width: `${width}%`, marginLeft: isPositive ? "auto" : `${100 - width}%` }}
              />
            </div>
            <span className={`w-16 text-right ${isPositive ? "text-green-600" : "text-red-600"}`}>
              {(isPositive ? "+" : "")}{(impact * 100).toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function LMSRTestPage() {
  const [lmsr] = useState(() => new BinaryLMSR());
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [selectedTrader, setSelectedTrader] = useState("trader1");
  const [buyMode, setBuyMode] = useState<"QTY" | "SPEND">("QTY");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [quantity, setQuantity] = useState("10");
  const [spend, setSpend] = useState("100");
  const [bParam, setBParam] = useState("100");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [showQuote, setShowQuote] = useState<QuoteQty | QuoteSpend | null>(null);

  // Initialize ledger
  useEffect(() => {
    resetMarket();
  }, [lmsr]);

  function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${message}`, ...prev].slice(0, 50));
  }

  function resetMarket() {
    const b = parseFloat(bParam);
    const newLedger = lmsr.initLedger(b, [
      { id: "trader1", cash: 10000 },
      { id: "trader2", cash: 10000 },
      { id: "trader3", cash: 10000 },
    ]);

    setLedger(newLedger);
    setLogs([]);
    setShowQuote(null);
    log(`Market reset with b=${b}, 3 traders with $10,000 each`);
    setError("");
  }

  function getMarketData() {
    if (!ledger) return null;
    const prices = lmsr.getPrices(ledger.market);
    return {
      pYES: prices.pYES.toNumber(),
      pNO: prices.pNO.toNumber(),
      qYes: ledger.market.qYes.toNumber(),
      qNo: ledger.market.qNo.toNumber(),
      b: ledger.market.b.toNumber(),
      totalCollected: ledger.market.totalCollected.toNumber(),
      worstCaseLoss: lmsr.worstCaseLoss(ledger.market.b).toNumber(),
      cost: lmsr.cost(ledger.market).toNumber(),
    };
  }

  function getTraderStates() {
    if (!ledger) return [];
    return Array.from(ledger.traders.values()).map((t) => ({
      id: t.traderId,
      cash: t.cash.toNumber(),
      yesShares: t.yesShares.toNumber(),
      noShares: t.noShares.toNumber(),
      totalShares: t.yesShares.plus(t.noShares).toNumber(),
    }));
  }

  function getQuote() {
    if (!ledger) return null;

    try {
      if (buyMode === "QTY") {
        const qty = parseFloat(quantity);
        if (isNaN(qty) || qty <= 0) {
          setError("Quantity must be positive");
          return null;
        }
        return lmsr.quoteQtyBuy(ledger.market, outcome, qty);
      } else {
        const spendAmt = parseFloat(spend);
        if (isNaN(spendAmt) || spendAmt <= 0) {
          setError("Spend must be positive");
          return null;
        }
        return lmsr.quoteSpendBuy(ledger.market, outcome, spendAmt);
      }
    } catch (e: any) {
      setError(e.message || "Quote failed");
      return null;
    }
  }

  function handleGetQuote() {
    setError("");
    const quote = getQuote();
    if (quote) {
      setShowQuote(quote);
      const cost = 'payment' in quote ? quote.payment : quote.spend;
      log(
        `QUOTE | ${outcome} | ` +
          (buyMode === "QTY"
            ? `Qty: ${quote.qty} | Cost: $${cost.toFixed(2)} | Avg Price: $${quote.avgPrice.toFixed(4)}`
            : `Spend: $${cost.toFixed(2)} | Qty: ${quote.qty.toFixed(2)} | Avg Price: $${quote.avgPrice.toFixed(4)}`)
      );
    }
  }

  function executeBuy() {
    if (!ledger) return;
    setError("");

    const trader = ledger.traders.get(selectedTrader);
    if (!trader) {
      setError("Trader not found");
      return;
    }

    try {
      let result;
      if (buyMode === "QTY") {
        const qty = parseFloat(quantity);
        if (isNaN(qty) || qty <= 0) {
          setError("Quantity must be positive");
          return;
        }
        result = lmsr.executeBuy(ledger, selectedTrader, outcome, qty);
      } else {
        const spendAmt = parseFloat(spend);
        if (isNaN(spendAmt) || spendAmt <= 0) {
          setError("Spend must be positive");
          return;
        }
        result = lmsr.executeBuySpend(ledger, selectedTrader, outcome, spendAmt);
      }

      // Apply the execution to the ledger
      ledger.market = result.newState;
      ledger.traders.set(selectedTrader, result.newTraderAccount);
      setLedger({ ...ledger });

      log(
        `TRADE | ${selectedTrader} bought ${result.qty.toFixed(2)} ${outcome} | ` +
          `Spend: $${result.spend.toFixed(2)} | Avg Price: $${result.avgPrice.toFixed(4)} | ` +
          `Price: ${result.pricesBefore.yes.toFixed(3)} → ${result.pricesAfter.yes.toFixed(3)}`
      );
      setShowQuote(null);
    } catch (e: any) {
      setError(e.message || "Buy failed");
    }
  }

  function settleMarket(outcome: Outcome) {
    if (!ledger) return;
    setError("");

    if (ledger.market.settled) {
      setError("Market already settled");
      return;
    }

    try {
      const settlement = lmsr.settle(ledger, outcome);
      (ledger.market as any).settled = true;
      (ledger.market as any).outcome = outcome;

      // Calculate payouts for each trader
      const payoutPerShare = outcome === "YES" ? new Decimal(1) : new Decimal(0);
      const noPayoutPerShare = outcome === "NO" ? new Decimal(1) : new Decimal(0);

      for (const [id, trader] of ledger.traders) {
        const yesPayout = trader.yesShares.times(payoutPerShare);
        const noPayout = trader.noShares.times(noPayoutPerShare);
        const totalPayout = yesPayout.plus(noPayout);
        trader.cash = trader.cash.plus(totalPayout);
      }

      setLedger({ ...ledger });

      log(
        `SETTLED | Outcome: ${outcome} | ` +
          `Total Payout: $${settlement.totalPayout.toFixed(2)} | ` +
          `Profit/Loss: $${settlement.profitLoss.toFixed(2)}`
      );
    } catch (e: any) {
      setError(e.message || "Settlement failed");
    }
  }

  function loadPreset(preset: string) {
    const b = parseFloat(bParam);
    const newLedger = lmsr.initLedger(b, [
      { id: "trader1", cash: 10000 },
      { id: "trader2", cash: 10000 },
      { id: "trader3", cash: 10000 },
    ]);

    switch (preset) {
      case "balanced": {
        // Balanced market - price near 0.5
        lmsr.executeBuy(newLedger, "trader1", "YES", 50);
        lmsr.executeBuy(newLedger, "trader2", "NO", 50);
        break;
      }
      case "bullish": {
        // Bullish - price above 0.5
        lmsr.executeBuy(newLedger, "trader1", "YES", 100);
        lmsr.executeBuy(newLedger, "trader2", "YES", 50);
        lmsr.executeBuy(newLedger, "trader3", "NO", 30);
        break;
      }
      case "bearish": {
        // Bearish - price below 0.5
        lmsr.executeBuy(newLedger, "trader1", "NO", 100);
        lmsr.executeBuy(newLedger, "trader2", "NO", 50);
        lmsr.executeBuy(newLedger, "trader3", "YES", 30);
        break;
      }
      case "illiquid": {
        // Illiquid - very few shares
        lmsr.executeBuy(newLedger, "trader1", "YES", 5);
        break;
      }
      case "liquid": {
        // Highly liquid
        lmsr.executeBuy(newLedger, "trader1", "YES", 500);
        lmsr.executeBuy(newLedger, "trader2", "NO", 500);
        break;
      }
    }

    setLedger(newLedger);
    setLogs([]);
    setShowQuote(null);
    log(`Loaded ${preset} preset`);
    setError("");
  }

  const marketData = getMarketData();
  const traders = getTraderStates();

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2 text-center">
          📊 LMSR Market Tester
        </h1>
        <p className="text-center text-gray-500 dark:text-gray-400 mb-8">
          Logarithmic Market Scoring Rule - Automated Market Maker
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Panel: Controls */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Place Order</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Trader ID
                </label>
                <select
                  value={selectedTrader}
                  onChange={(e) => setSelectedTrader(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="trader1">trader1</option>
                  <option value="trader2">trader2</option>
                  <option value="trader3">trader3</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Outcome
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOutcome("YES")}
                    className={`flex-1 px-4 py-2 rounded-md font-medium ${
                      outcome === "YES"
                        ? "bg-green-600 text-white"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                    }`}
                  >
                    YES
                  </button>
                  <button
                    onClick={() => setOutcome("NO")}
                    className={`flex-1 px-4 py-2 rounded-md font-medium ${
                      outcome === "NO"
                        ? "bg-red-600 text-white"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                    }`}
                  >
                    NO
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Buy Mode
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setBuyMode("QTY")}
                    className={`flex-1 px-4 py-2 rounded-md font-medium text-sm ${
                      buyMode === "QTY"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                    }`}
                  >
                    By Quantity
                  </button>
                  <button
                    onClick={() => setBuyMode("SPEND")}
                    className={`flex-1 px-4 py-2 rounded-md font-medium text-sm ${
                      buyMode === "SPEND"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                    }`}
                  >
                    By Spend
                  </button>
                </div>
              </div>

              {buyMode === "QTY" ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Quantity (shares)
                  </label>
                  <input
                    type="number"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    step="1"
                    min="1"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Spend Amount ($)
                  </label>
                  <input
                    type="number"
                    value={spend}
                    onChange={(e) => setSpend(e.target.value)}
                    step="10"
                    min="1"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleGetQuote}
                  className="px-4 py-2 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded-md hover:bg-blue-200 dark:hover:bg-blue-800 font-medium"
                >
                  Get Quote
                </button>
                <button
                  onClick={executeBuy}
                  className={`px-4 py-2 rounded-md font-medium ${
                    outcome === "YES"
                      ? "bg-green-600 text-white hover:bg-green-700"
                      : "bg-red-600 text-white hover:bg-red-700"
                  }`}
                >
                  Execute Buy
                </button>
              </div>

              {/* Quote Display */}
              {showQuote && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                  <div className="text-sm font-medium text-blue-800 dark:text-blue-300 mb-2">
                    Quote for {outcome}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-gray-500">Qty:</span>{" "}
                      <span className="font-semibold">{showQuote.qty.toFixed(2)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Cost:</span>{" "}
                      <span className="font-semibold">
                        ${'payment' in showQuote ? showQuote.payment.toFixed(2) : showQuote.spend.toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-500">Avg Price:</span>{" "}
                      <span className="font-semibold">${showQuote.avgPrice.toFixed(4)}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Price After:</span>{" "}
                      <span className="font-semibold">{showQuote.pricesAfter.yes.toFixed(3)}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Liquidity Parameter (b)
                </h3>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={bParam}
                    onChange={(e) => setBParam(e.target.value)}
                    step="10"
                    min="1"
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                  <button
                    onClick={resetMarket}
                    className="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 font-medium"
                  >
                    Reset
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Higher b = more liquidity, less slippage
                </p>
              </div>

              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Presets
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => loadPreset("balanced")}
                    className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-sm hover:bg-gray-200 dark:hover:bg-gray-600"
                  >
                    Balanced
                  </button>
                  <button
                    onClick={() => loadPreset("bullish")}
                    className="px-3 py-2 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded text-sm hover:bg-green-200 dark:hover:bg-green-800"
                  >
                    Bullish
                  </button>
                  <button
                    onClick={() => loadPreset("bearish")}
                    className="px-3 py-2 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded text-sm hover:bg-red-200 dark:hover:bg-red-800"
                  >
                    Bearish
                  </button>
                  <button
                    onClick={() => loadPreset("illiquid")}
                    className="px-3 py-2 bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 rounded text-sm hover:bg-yellow-200 dark:hover:bg-yellow-800"
                  >
                    Illiquid
                  </button>
                  <button
                    onClick={() => loadPreset("liquid")}
                    className="px-3 py-2 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded text-sm hover:bg-blue-200 dark:hover:bg-blue-800"
                  >
                    Liquid
                  </button>
                  <button
                    onClick={resetMarket}
                    className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-sm hover:bg-gray-200 dark:hover:bg-gray-600"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {!ledger?.market.settled && (
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Settle Market
                  </h3>
                  <div className="flex gap-2">
                    <button
                      onClick={() => settleMarket("YES")}
                      className="flex-1 px-3 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700"
                    >
                      Settle YES
                    </button>
                    <button
                      onClick={() => settleMarket("NO")}
                      className="flex-1 px-3 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700"
                    >
                      Settle NO
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}
            </div>
          </div>

          {/* Center Panel: Market State */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Market State</h2>

            {marketData && (
              <>
                {/* Price Display */}
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="text-center p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                    <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">YES Price</div>
                    <div className="text-2xl font-bold text-green-600">
                      {(marketData.pYES * 100).toFixed(1)}¢
                    </div>
                    <div className="text-xs text-gray-500">${marketData.pYES.toFixed(4)}</div>
                  </div>
                  <div className="text-center p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
                    <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">NO Price</div>
                    <div className="text-2xl font-bold text-red-600">
                      {(marketData.pNO * 100).toFixed(1)}¢
                    </div>
                    <div className="text-xs text-gray-500">${marketData.pNO.toFixed(4)}</div>
                  </div>
                </div>

                {/* Outstanding Shares */}
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                    <div className="text-xs text-gray-500 dark:text-gray-400">YES Outstanding</div>
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">
                      {marketData.qYes.toFixed(0)}
                    </div>
                  </div>
                  <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                    <div className="text-xs text-gray-500 dark:text-gray-400">NO Outstanding</div>
                    <div className="text-lg font-semibold text-gray-900 dark:text-white">
                      {marketData.qNo.toFixed(0)}
                    </div>
                  </div>
                </div>

                {/* Market Metrics */}
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Liquidity (b)</div>
                    <div className="text-lg font-semibold text-blue-600">
                      {marketData.b.toFixed(0)}
                    </div>
                  </div>
                  <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Total Collected</div>
                    <div className="text-lg font-semibold text-purple-600">
                      ${marketData.totalCollected.toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="text-center p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded mb-6">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Worst Case Loss</div>
                  <div className="text-lg font-semibold text-yellow-600">
                    ${marketData.worstCaseLoss.toFixed(2)}
                  </div>
                </div>

                {/* Cost Curve Chart */}
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Cost Curve (Price vs YES Shares)
                  </h3>
                  <div className="h-48 border border-gray-200 dark:border-gray-700 rounded-lg">
                    <CostCurveChart b={marketData.b} qYes={marketData.qYes} qNo={marketData.qNo} />
                  </div>
                </div>

                {/* Price Impact */}
                <div>
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Price Impact (Buying YES)
                  </h3>
                  <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <PriceImpactChart b={marketData.b} qYes={marketData.qYes} qNo={marketData.qNo} />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Right Panel: Traders & Logs */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Trader States</h2>
            <div className="max-h-64 overflow-y-auto mb-4">
              {traders.map((trader) => (
                <div
                  key={trader.id}
                  className="flex justify-between items-center p-3 border-b border-gray-100 dark:border-gray-700"
                >
                  <div>
                    <div className="font-medium text-gray-700 dark:text-gray-300">{trader.id}</div>
                    <div className="text-xs text-gray-500">
                      {trader.yesShares.toFixed(0)} YES | {trader.noShares.toFixed(0)} NO
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-yellow-600 font-semibold">💰 ${trader.cash.toFixed(2)}</div>
                    <div className="text-xs text-blue-600">{trader.totalShares.toFixed(0)} shares</div>
                  </div>
                </div>
              ))}
            </div>

            {ledger?.market.settled && (
              <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md mb-4">
                <div className="text-sm font-medium text-green-800 dark:text-green-300">
                  Market Settled: {ledger.market.outcome}
                </div>
              </div>
            )}

            <h2 className="text-lg font-semibold mb-2 text-gray-800 dark:text-white">Event Log</h2>
            <div className="h-80 overflow-y-auto bg-gray-50 dark:bg-gray-900 rounded p-2 font-mono text-xs">
              {logs.map((log, i) => (
                <div key={i} className="mb-1 pb-1 border-b border-gray-200 dark:border-gray-700">
                  {log}
                </div>
              ))}
              {logs.length === 0 && (
                <div className="text-gray-400 text-center py-4">
                  No events yet - place an order or load a preset
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
