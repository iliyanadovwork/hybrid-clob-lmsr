"use client";

import { useState, useEffect } from "react";
import { CLOBEngine, CLOBLedger, type Side } from "@/lib/clob";

export default function CLOBTestPage() {
  const [clob] = useState(() => new CLOBEngine());
  const [ledger, setLedger] = useState<CLOBLedger | null>(null);
  const [selectedTrader, setSelectedTrader] = useState("trader1");
  const [orderType, setOrderType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [price, setPrice] = useState("0.50");
  const [quantity, setQuantity] = useState("10");
  const [cancelOrderId, setCancelOrderId] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");

  // Initialize ledger
  useEffect(() => {
    resetBook();
  }, [clob]);

  function log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [`[${timestamp}] ${message}`, ...prev].slice(0, 50));
  }

  function resetBook() {
    const newLedger = clob.initLedger([
      { id: "trader1", cash: 10000 },
      { id: "trader2", cash: 10000 },
      { id: "trader3", cash: 10000 },
    ]);

    // Give each trader 100 initial shares
    const trader1 = newLedger.traders.get("trader1")!;
    const trader2 = newLedger.traders.get("trader2")!;
    const trader3 = newLedger.traders.get("trader3")!;
    trader1.yesShares = trader1.yesShares.plus(100);
    trader2.yesShares = trader2.yesShares.plus(100);
    trader3.yesShares = trader3.yesShares.plus(100);

    setLedger(newLedger);
    setLogs([]);
    log("Book reset with 3 traders, 100 shares each");
    setError("");
  }

  function getMarketData() {
    if (!ledger) return null;
    const book = ledger.market.orderBook;
    return {
      bestBid: clob.getBestBid(book),
      bestAsk: clob.getBestAsk(book),
      spread: clob.getSpread(book),
      midPrice: clob.getMidPrice(book),
      bidDepth: clob.getDepth(book, "BUY", 3),
      askDepth: clob.getDepth(book, "SELL", 3),
    };
  }

  function getOrderBook() {
    if (!ledger) return { bids: [], asks: [] };

    const book = ledger.market.orderBook;

    const bids = Array.from(book.bids.values()).map(level => ({
      price: level.price.toNumber(),
      totalQty: level.totalQty.toNumber(),
      orders: level.orders.length,
      ordersList: level.orders,
    })).sort((a, b) => b.price - a.price);

    const asks = Array.from(book.asks.values()).map(level => ({
      price: level.price.toNumber(),
      totalQty: level.totalQty.toNumber(),
      orders: level.orders.length,
      ordersList: level.orders,
    })).sort((a, b) => a.price - b.price);

    return { bids, asks };
  }

  function getTraderStates() {
    if (!ledger) return [];
    return Array.from(ledger.traders.values()).map(t => ({
      id: t.traderId,
      cash: t.cash.toNumber(),
      shares: t.yesShares.toNumber(),
      openOrders: t.openOrders.size,
    }));
  }

  function getOpenOrders() {
    if (!ledger) return [];
    const orders: any[] = [];
    for (const [, trader] of ledger.traders) {
      for (const orderId of trader.openOrders) {
        const bid = Array.from(ledger.market.orderBook.bids.values()).find(l =>
          l.orders.some(o => o.orderId === orderId)
        );
        const ask = Array.from(ledger.market.orderBook.asks.values()).find(l =>
          l.orders.some(o => o.orderId === orderId)
        );
        if (bid) {
          const order = bid.orders.find(o => o.orderId === orderId);
          if (order) {
            orders.push({ ...order, price: order.price.toNumber(), qty: order.qty.toNumber() });
          }
        }
        if (ask) {
          const order = ask.orders.find(o => o.orderId === orderId);
          if (order) {
            orders.push({ ...order, price: order.price.toNumber(), qty: order.qty.toNumber() });
          }
        }
      }
    }
    return orders;
  }

  function validateSellAllowed(traderId: string, qty: number): { allowed: boolean; reason?: string } {
    if (!ledger) return { allowed: false, reason: "No ledger" };

    const trader = ledger.traders.get(traderId);
    if (!trader) return { allowed: false, reason: "Trader not found" };

    // Calculate how many shares this trader has in open sell orders
    let openSellQty = 0;
    for (const [, level] of ledger.market.orderBook.asks) {
      for (const order of level.orders) {
        if (order.traderId === traderId) {
          openSellQty += order.qty.toNumber();
        }
      }
    }

    const totalAvailable = trader.yesShares.toNumber();
    if (qty > totalAvailable) {
      return { allowed: false, reason: `Insufficient shares. Have: ${totalAvailable}, Trying to sell: ${qty}` };
    }

    return { allowed: true };
  }

  function placeBuyOrder() {
    if (!ledger) return;
    setError("");

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      setError("Quantity must be a positive number");
      return;
    }

    try {
      let result;
      if (orderType === "MARKET") {
        result = clob.placeMarketOrder(ledger, selectedTrader, "BUY", qty);
        log(`MARKET BUY | Trader: ${selectedTrader} | Qty: ${qty} | Filled: ${result.filledQty}`);
      } else {
        const priceNum = parseFloat(price);
        if (isNaN(priceNum) || priceNum < 0.01 || priceNum > 0.99) {
          setError("Price must be between $0.01 and $0.99");
          return;
        }
        result = clob.placeLimitOrder(ledger, selectedTrader, "BUY", priceNum, qty);
        log(`LIMIT BUY | ID: ${result.orderId} | Price: $${priceNum.toFixed(2)} | Qty: ${qty} | Status: ${result.status}`);
      }

      for (const trade of result.trades) {
        const value = trade.price.times(trade.qty).toNumber();
        log(`TRADE | Price: $${trade.price.toNumber().toFixed(2)} | Qty: ${trade.qty} | Value: $${value.toFixed(2)}`);
      }

      setLedger({ ...ledger });
    } catch (e: any) {
      setError(e.message || "Buy order failed");
    }
  }

  function placeSellOrder() {
    if (!ledger) return;
    setError("");

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      setError("Quantity must be a positive number");
      return;
    }

    // Check if trader has enough shares
    const check = validateSellAllowed(selectedTrader, qty);
    if (!check.allowed) {
      setError(check.reason || "Sell not allowed");
      return;
    }

    try {
      let result;
      if (orderType === "MARKET") {
        result = clob.placeMarketOrder(ledger, selectedTrader, "SELL", qty);
        log(`MARKET SELL | Trader: ${selectedTrader} | Qty: ${qty} | Filled: ${result.filledQty}`);
      } else {
        const priceNum = parseFloat(price);
        if (isNaN(priceNum) || priceNum < 0.01 || priceNum > 0.99) {
          setError("Price must be between $0.01 and $0.99");
          return;
        }
        result = clob.placeLimitOrder(ledger, selectedTrader, "SELL", priceNum, qty);
        log(`LIMIT SELL | ID: ${result.orderId} | Price: $${priceNum.toFixed(2)} | Qty: ${qty} | Status: ${result.status}`);
      }

      for (const trade of result.trades) {
        const value = trade.price.times(trade.qty).toNumber();
        log(`TRADE | Price: $${trade.price.toNumber().toFixed(2)} | Qty: ${trade.qty} | Value: $${value.toFixed(2)}`);
      }

      setLedger({ ...ledger });
    } catch (e: any) {
      setError(e.message || "Sell order failed");
    }
  }

  function cancelOrder() {
    if (!ledger) return;
    setError("");

    if (!cancelOrderId) {
      setError("Please enter an Order ID");
      return;
    }

    try {
      const result = clob.cancelOrder(ledger, cancelOrderId);
      log(`CANCEL | ID: ${cancelOrderId} | Status: ${result.status}`);
      setLedger({ ...ledger });
    } catch (e: any) {
      setError(e.message || "Cancel failed");
    }
  }

  function loadPreset(preset: string) {
    // Create a fresh new ledger, reset logs
    const newLedger = clob.initLedger([
      { id: "trader1", cash: 10000 },
      { id: "trader2", cash: 10000 },
      { id: "trader3", cash: 10000 },
    ]);

    // Give each trader 100 initial shares
    const trader1 = newLedger.traders.get("trader1")!;
    const trader2 = newLedger.traders.get("trader2")!;
    const trader3 = newLedger.traders.get("trader3")!;
    trader1.yesShares = trader1.yesShares.plus(100);
    trader2.yesShares = trader2.yesShares.plus(100);
    trader3.yesShares = trader3.yesShares.plus(100);

    // Apply preset orders to the new ledger
    switch (preset) {
      case "thin":
        clob.placeLimitOrder(newLedger, "trader1", "SELL", 0.55, 5);
        clob.placeLimitOrder(newLedger, "trader2", "SELL", 0.60, 3);
        clob.placeLimitOrder(newLedger, "trader1", "BUY", 0.45, 8);
        clob.placeLimitOrder(newLedger, "trader3", "BUY", 0.40, 5);
        break;
      case "thick":
        for (let i = 0; i < 5; i++) {
          const trader = `trader${(i % 3) + 1}` as const;
          clob.placeLimitOrder(newLedger, trader, "SELL", 0.50 + (i + 1) * 0.02, 20 + i * 5);
          clob.placeLimitOrder(newLedger, trader, "BUY", 0.50 - (i + 1) * 0.02, 20 + i * 5);
        }
        break;
      case "crossed":
        clob.placeLimitOrder(newLedger, "trader1", "BUY", 0.55, 10);
        clob.placeLimitOrder(newLedger, "trader2", "SELL", 0.52, 8);
        break;
      case "fifo":
        clob.placeLimitOrder(newLedger, "trader1", "BUY", 0.50, 10);
        clob.placeLimitOrder(newLedger, "trader2", "BUY", 0.50, 5);
        clob.placeLimitOrder(newLedger, "trader3", "BUY", 0.50, 8);
        clob.placeLimitOrder(newLedger, "trader1", "SELL", 0.50, 15);
        break;
    }

    setLedger(newLedger);
    setLogs([]);
    log(`Loaded ${preset} preset`);
    setError("");
  }

  const marketData = getMarketData();
  const { bids, asks } = getOrderBook();
  const traders = getTraderStates();
  const openOrders = getOpenOrders();

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 p-8">
      <div className="max-w-1600 mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8 text-center">
          📈 CLOB Order Book Tester
        </h1>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Panel: Controls */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Place Order</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Trader ID</label>
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
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Order Type</label>
                <select
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value as "LIMIT" | "MARKET")}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                >
                  <option value="LIMIT">Limit Order</option>
                  <option value="MARKET">Market Order</option>
                </select>
              </div>

              {orderType === "LIMIT" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Price ($0.01 - $0.99)</label>
                  <input
                    type="number"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    step="0.01"
                    min="0.01"
                    max="0.99"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity</label>
                <input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  step="1"
                  min="1"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>

              <button
                onClick={placeBuyOrder}
                className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium"
              >
                🟢 BUY
              </button>

              <button
                onClick={placeSellOrder}
                className="w-full px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 font-medium"
              >
                🔴 SELL
              </button>

              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Cancel Order</h3>
                <input
                  type="text"
                  value={cancelOrderId}
                  onChange={(e) => setCancelOrderId(e.target.value)}
                  placeholder="Order ID (e.g., ord-1)"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white mb-2"
                />
                <button
                  onClick={cancelOrder}
                  className="w-full px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 font-medium"
                >
                  Cancel Order
                </button>
              </div>

              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Presets</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => loadPreset("thin")} className="px-3 py-2 bg-blue-100 text-blue-700 rounded text-sm hover:bg-blue-200">Thin</button>
                  <button onClick={() => loadPreset("thick")} className="px-3 py-2 bg-green-100 text-green-700 rounded text-sm hover:bg-green-200">Thick</button>
                  <button onClick={() => loadPreset("crossed")} className="px-3 py-2 bg-orange-100 text-orange-700 rounded text-sm hover:bg-orange-200">Crossed</button>
                  <button onClick={() => loadPreset("fifo")} className="px-3 py-2 bg-purple-100 text-purple-700 rounded text-sm hover:bg-purple-200">FIFO</button>
                  <button onClick={resetBook} className="col-span-2 px-3 py-2 bg-gray-100 text-gray-700 rounded text-sm hover:bg-gray-200">Reset Book</button>
                </div>
              </div>

              {error && (
                <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}
            </div>
          </div>

          {/* Center Panel: Order Book */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Order Book</h2>

            {marketData && (
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Best Bid</div>
                  <div className="text-lg font-semibold text-green-600">
                    {marketData.bestBid ? `$${marketData.bestBid.toFixed(2)}` : "--"}
                  </div>
                </div>
                <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Spread</div>
                  <div className="text-lg font-semibold text-blue-600">
                    {marketData.spread ? `$${marketData.spread.toFixed(4)}` : "--"}
                  </div>
                </div>
                <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded">
                  <div className="text-xs text-gray-500 dark:text-gray-400">Best Ask</div>
                  <div className="text-lg font-semibold text-red-600">
                    {marketData.bestAsk ? `$${marketData.bestAsk.toFixed(2)}` : "--"}
                  </div>
                </div>
              </div>
            )}

            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <div className="grid grid-cols-3 gap-2 p-2 bg-gray-50 dark:bg-gray-700 text-xs font-medium text-gray-500 dark:text-gray-400">
                <span className="text-right">Bid Qty</span>
                <span className="text-center">Price</span>
                <span>Ask Qty</span>
              </div>

              {/* Asks */}
              <div className="max-h-48 overflow-y-auto">
                {asks.slice(-10).reverse().map((ask, i) => (
                  <div key={`ask-${i}`} className="grid grid-cols-3 gap-2 p-2 text-sm border-b border-gray-100 dark:border-gray-700 text-red-600">
                    <span className="text-right"></span>
                    <span className="text-center font-medium">${typeof ask.price === 'number' ? ask.price.toFixed(2) : ask.price}</span>
                    <span>{ask.totalQty}</span>
                  </div>
                ))}
              </div>

              {/* Spread */}
              <div className="p-3 bg-gray-50 dark:bg-gray-700 text-center text-sm font-medium border-y border-gray-200 dark:border-gray-700">
                {marketData?.spread ? `Spread: $${marketData.spread.toFixed(4)} | Mid: $${marketData.midPrice?.toFixed(2)}` : "No orders"}
              </div>

              {/* Bids */}
              <div className="max-h-48 overflow-y-auto">
                {bids.slice(0, 10).map((bid, i) => (
                  <div key={`bid-${i}`} className="grid grid-cols-3 gap-2 p-2 text-sm border-b border-gray-100 dark:border-gray-700 text-green-600">
                    <span className="text-right">{bid.totalQty}</span>
                    <span className="text-center font-medium">${typeof bid.price === 'number' ? bid.price.toFixed(2) : bid.price}</span>
                    <span></span>
                  </div>
                ))}
              </div>

              {asks.length === 0 && bids.length === 0 && (
                <div className="p-8 text-center text-gray-400 text-sm">
                  No orders - click a preset to load sample orders
                </div>
              )}
            </div>
          </div>

          {/* Right Panel: Traders & Logs */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Trader States</h2>
            <div className="max-h-48 overflow-y-auto mb-4">
              {traders.map((trader) => (
                <div key={trader.id} className="flex justify-between items-center p-2 border-b border-gray-100 dark:border-gray-700 text-sm">
                  <div>
                    <div className="font-medium text-gray-700 dark:text-gray-300">{trader.id}</div>
                    <div className="text-xs text-gray-500">Orders: {trader.openOrders}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-yellow-600">💰 ${trader.cash.toFixed(2)}</div>
                    <div className="text-blue-600">📈 {trader.shares.toFixed(1)} shares</div>
                  </div>
                </div>
              ))}
            </div>

            <h2 className="text-lg font-semibold mb-2 text-gray-800 dark:text-white">Open Orders</h2>
            <div className="max-h-32 overflow-y-auto mb-4">
              {openOrders.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-2">No open orders</div>
              ) : (
                openOrders.map((order) => (
                  <div key={order.orderId} className="flex justify-between p-2 border-b border-gray-100 dark:border-gray-700 text-xs">
                    <span className={order.side === "BUY" ? "text-green-600" : "text-red-600"}>
                      {order.side} ${typeof order.price === 'number' ? order.price.toFixed(2) : order.price}
                    </span>
                    <span className="text-gray-500">ID:{order.orderId} | {typeof order.qty === 'number' ? order.qty : order.qty.toFixed(0)} | {order.traderId}</span>
                  </div>
                ))
              )}
            </div>

            <h2 className="text-lg font-semibold mb-2 text-gray-800 dark:text-white">Event Log</h2>
            <div className="h-64 overflow-y-auto bg-gray-50 dark:bg-gray-900 rounded p-2 font-mono text-xs">
              {logs.map((log, i) => (
                <div key={i} className="mb-1 pb-1 border-b border-gray-200 dark:border-gray-700">
                  {log}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
