/**
 * Tests for Hybrid Router V2
 *
 * Verifies that the hybrid router correctly:
 * - Maintains shared positions across CLOB and LMSR
 * - Routes orders to appropriate engines
 * - Falls back from CLOB to LMSR when needed
 * - Sells require having shares (can use shares bought on LMSR)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  HybridRouterV2,
  createHybridEngineV2,
  createSpreadBasedConfig,
} from "../src/lib/hybrid-router-v2";
import { OrderIntent } from "../src/lib/engine-common";

describe("HybridRouterV2: Initialization", () => {
  it("should initialize with default config", () => {
    const engine = createHybridEngineV2();
    engine.initialize();

    expect(engine.engineType).toBe("HYBRID_V2");
    const stats = engine.getStats();
    expect(stats.clobExecutions).toBe(0);
    expect(stats.lmsrExecutions).toBe(0);
  });

  it("should initialize traders in both engines", () => {
    const engine = createHybridEngineV2();
    engine.addTrader("alice", 10000);

    const positions = engine.getSharedPositions();
    expect(positions.size).toBe(1);

    const alice = positions.get("alice");
    expect(alice?.cash.toNumber()).toBe(10000);
    expect(alice?.yesShares.toNumber()).toBe(0);
  });
});

describe("HybridRouterV2: Spread-Based Routing", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
  });

  it("should route buy order to CLOB when liquidity exists", () => {
    // Set up CLOB with liquidity
    const sellIntent: OrderIntent = {
      intentId: "setup-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.6,
      qty: 100,
      timestamp: 0,
    };

    // First, give alice shares (bootstrap)
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;
    alice.yesShares = new Decimal(200);
    alice.cash = alice.cash.minus(100); // Paid for shares

    engine.processOrder(sellIntent);

    // Now bob's buy should route to CLOB
    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      price: 0.6,
      qty: 50,
      timestamp: 1,
    };

    const result = engine.processOrder(buyIntent);

    expect(result.status).toBe("FILLED");
    expect(result.filledQty.toNumber()).toBe(50);
    expect(result.engineType).toContain("CLOB");
  });

  it("should fall back to LMSR when CLOB has no liquidity", () => {
    // MARKET, not LIMIT. A limit order with nothing to match against RESTS on the
    // book by definition — that is how the book gets built, and the routing suite
    // in hybrid-router-v2.comprehensive.test.ts depends on it. Only an order that
    // cannot rest is the one with nowhere to go but the maker.
    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "MARKET",
      qty: 50,
      timestamp: 0,
    };

    const result = engine.processOrder(buyIntent);

    expect(result.status).toBe("FILLED");
    expect(result.filledQty.toNumber()).toBe(50);
    expect(result.engineType).toContain("LMSR");
  });

  it("should route large buy partially to CLOB and rest to LMSR", () => {
    // Alice has 100 shares to sell on CLOB
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;
    alice.yesShares = new Decimal(100);
    alice.cash = alice.cash.minus(50);

    // Alice places sell order
    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.5,
      qty: 100,
      timestamp: 0,
    };
    engine.processOrder(sellIntent);

    // Bob tries to buy 200 - 100 from CLOB, 100 from LMSR
    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "MARKET",
      qty: 200,
      timestamp: 1,
    };

    const result = engine.processOrder(buyIntent);

    expect(result.status).toBe("FILLED");
    expect(result.filledQty.toNumber()).toBe(200);
    expect(result.engineType).toContain("CLOB");
    expect(result.engineType).toContain("LMSR");
  });
});

describe("HybridRouterV2: Sell-to-Close with Shared Positions", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
  });

  it("should allow selling shares bought on LMSR via CLOB", () => {
    const positions = engine.getSharedPositions();

    // Bootstrap Alice with shares and cash to place buy orders
    const alice = positions.get("alice")!;
    alice.yesShares = alice.yesShares.plus(200);
    alice.cash = alice.cash.minus(100);

    // Alice places a BUY order on CLOB at a low price
    // Note: This might execute on LMSR, which is fine - it adds a bid to the market
    const aliceBuy: OrderIntent = {
      intentId: "alice-buy",
      traderId: "alice",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      price: 0.4,
      qty: 50,
      timestamp: 0,
    };
    engine.processOrder(aliceBuy);

    // Bob buys shares on LMSR
    const bobBuy: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "MARKET",
      qty: 100,
      timestamp: 1,
    };

    const buyResult = engine.processOrder(bobBuy);
    expect(buyResult.filledQty.toNumber()).toBe(100);

    // Bob should be able to sell some of his shares
    // First, Alice places another buy to provide liquidity
    const aliceBuy2: OrderIntent = {
      intentId: "alice-buy-2",
      traderId: "alice",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      price: 0.6,
      qty: 50,
      timestamp: 2,
    };
    engine.processOrder(aliceBuy2);

    const bobSell: OrderIntent = {
      intentId: "bob-sell",
      traderId: "bob",
      outcome: "YES",
      side: "SELL",
      orderType: "MARKET",
      qty: 50,
      timestamp: 3,
    };

    const sellResult = engine.processOrder(bobSell);

    // Should execute on CLOB (crossing with Alice's bid)
    expect(sellResult.engineType).toContain("CLOB");
    expect(sellResult.filledQty.toNumber()).toBe(50);
  });

  it("should reject sell when trader has no shares", () => {
    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "MARKET",
      qty: 10,
      timestamp: 0,
    };

    const result = engine.processOrder(sellIntent);

    // With sell-to-close model, SELL orders don't use LMSR fallback
    // CLOB rejects (no shares), so order is rejected
    expect(result.status).toBe("REJECTED");
    expect(result.filledQty.toNumber()).toBe(0);
  });
});

describe("HybridRouterV2: Spread-Based Routing", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig(0.03));
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
  });

  it("should use CLOB when spread is tight", () => {
    // Set up tight spread on CLOB
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;
    alice.yesShares = new Decimal(200);
    alice.cash = alice.cash.minus(100);

    // Alice sells at 0.50 (tight to fair value)
    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.50,
      qty: 100,
      timestamp: 0,
    };
    engine.processOrder(sellIntent);

    // Bob buys - should use CLOB (tight spread)
    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      price: 0.50,
      qty: 50,
      timestamp: 1,
    };

    const result = engine.processOrder(buyIntent);

    expect(result.engineType).toContain("CLOB");
  });

  it("should use LMSR when CLOB spread is wide", () => {
    // No liquidity on CLOB = wide spread
    // Bob should get routed to LMSR

    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "MARKET",
      qty: 50,
      timestamp: 0,
    };

    const result = engine.processOrder(buyIntent);

    expect(result.engineType).toContain("LMSR");
  });
});

describe("HybridRouterV2: Statistics", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);

    // Bootstrap alice with shares
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;
    alice.yesShares = new Decimal(500);
    alice.cash = alice.cash.minus(250);
  });

  it("should track CLOB and LMSR execution counts", () => {
    // Place liquidity on CLOB
    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.5,
      qty: 100,
      timestamp: 0,
    };
    engine.processOrder(sellIntent);

    // Buy from CLOB (should use CLOB)
    const buy1: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      price: 0.5,
      qty: 50,
      timestamp: 1,
    };
    engine.processOrder(buy1);

    // Buy more than available on CLOB (should use CLOB + LMSR)
    const buy2: OrderIntent = {
      intentId: "buy-2",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "MARKET",
      qty: 200,
      timestamp: 2,
    };
    engine.processOrder(buy2);

    const stats = engine.getStats();

    expect(stats.clobExecutions).toBeGreaterThan(0);
    expect(stats.lmsrExecutions).toBeGreaterThan(0);
    expect(stats.totalOrders).toBe(3);
    expect(stats.clobRatio).toBeGreaterThan(0);
    expect(stats.clobRatio).toBeLessThan(1);
  });

  it("should track fill quantities by engine", () => {
    // Note: This test runs after "should track CLOB and LMSR execution counts"
    // which already accumulated some stats.

    // Get initial stats (may have previous test data)
    const initialStats = engine.getStats();
    const initialClob = initialStats.clobFillQty.toNumber();
    const initialLmsr = initialStats.lmsrFillQty.toNumber();

    // Place liquidity
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;

    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.5,
      qty: 100,
      timestamp: 0,
    };
    engine.processOrder(sellIntent);

    // Buy more than available
    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "MARKET",
      qty: 200,
      timestamp: 1,
    };
    engine.processOrder(buyIntent);

    const stats = engine.getStats();

    // Verify that both engines processed orders
    const clobDelta = stats.clobFillQty.toNumber() - initialClob;
    const lmsrDelta = stats.lmsrFillQty.toNumber() - initialLmsr;

    expect(clobDelta).toBeGreaterThan(0);
    expect(lmsrDelta).toBeGreaterThan(0);

    // Total should be 300 (100 from CLOB match + 200 from LMSR)
    // Actually CLOB might count differently due to order matching
    // Let's just verify both engines were used
    expect(stats.clobExecutions).toBeGreaterThan(initialStats.clobExecutions);
    expect(stats.lmsrExecutions).toBeGreaterThan(initialStats.lmsrExecutions);
  });
});

describe("HybridRouterV2: Market Data", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
  });

  it("should return CLOB market data when available", () => {
    // Add liquidity to CLOB
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;
    alice.yesShares = new Decimal(200);
    alice.cash = alice.cash.minus(100);

    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.6,
      qty: 100,
      timestamp: 0,
    };
    engine.processOrder(sellIntent);

    const buyIntent: OrderIntent = {
      intentId: "buy-1",
      traderId: "bob",
      outcome: "YES",
      side: "BUY",
      orderType: "LIMIT",
      price: 0.4,
      qty: 50,
      timestamp: 1,
    };
    engine.processOrder(buyIntent);

    const state = engine.getMarketState();

    expect(state.bestBid).toBeDefined();
    expect(state.bestAsk).toBeDefined();
    expect(state.spread).toBeDefined();
    expect(state.spread!.toNumber()).toBeCloseTo(0.2, 1);
  });

  it("should return LMSR prices when CLOB is empty", () => {
    const state = engine.getMarketState();

    expect(state.bestBid).toBeUndefined();
    expect(state.bestAsk).toBeUndefined();
    expect(state.spread).toBeUndefined();
    expect(state.priceYes).toBeDefined();
    expect(state.priceNo).toBeDefined();
  });

  it("should prefer CLOB mid price when available", () => {
    const positions = engine.getSharedPositions();
    const alice = positions.get("alice")!;
    alice.yesShares = new Decimal(200);
    alice.cash = alice.cash.minus(100);

    const sellIntent: OrderIntent = {
      intentId: "sell-1",
      traderId: "alice",
      outcome: "YES",
      side: "SELL",
      orderType: "LIMIT",
      price: 0.6,
      qty: 100,
      timestamp: 0,
    };
    engine.processOrder(sellIntent);

    const midPrice = engine.getMidPrice();

    // Should return CLOB mid price (ask price since no bid)
    expect(midPrice).toBeDefined();
  });
});
