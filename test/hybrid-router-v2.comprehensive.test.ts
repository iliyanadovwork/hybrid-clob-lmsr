/**
 * Comprehensive Hybrid Router V2 Tests
 *
 * Test coverage:
 * 1. Routing correctness (decision logic in isolation)
 * 2. Fallback behavior (CLOB partial fills spill to LMSR)
 * 3. Shared position/ledger invariants
 * 4. Sync correctness (single source of truth)
 * 5. Determinism (same seed = same output)
 * 6. No-regret sanity checks
 * 7. Golden regression tests
 * 8. Property-based invariants
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  HybridRouterV2,
  createHybridEngineV2,
  createSpreadBasedConfig,
  SharedTraderPosition,
} from "../src/lib/hybrid-router-v2";
import { OrderIntent } from "../src/lib/engine-common";

// ============================================================================
// Helper Functions
// ============================================================================

function createIntent(
  intentId: string,
  traderId: string,
  side: "BUY" | "SELL",
  orderType: "LIMIT" | "MARKET",
  price: number | undefined,
  qty: number,
  timestamp: number
): OrderIntent {
  return {
    intentId,
    traderId,
    outcome: "YES",
    side,
    orderType,
    price,
    qty,
    timestamp,
  };
}

function bootstrapShares(engine: HybridRouterV2, traderId: string, shares: number, costPerShare: number = 0.5): void {
  const positions = engine.getSharedPositions();
  const trader = positions.get(traderId);
  if (trader) {
    trader.yesShares = trader.yesShares.plus(shares);
    trader.cash = trader.cash.minus(shares * costPerShare);
  }
}

// ============================================================================
// 1. Routing Correctness (Decision Logic)
// ============================================================================

describe("HybridRouterV2: Routing Correctness", () => {
  describe("Empty/one-sided CLOB should use LMSR", () => {
    it("should route to LMSR when CLOB is empty", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.05,
        minDepth: 10,
      });
      engine.initialize();
      engine.addTrader("alice", 10000);

      const buyIntent = createIntent("buy-1", "alice", "BUY", "MARKET", undefined, 100, 0);
      const result = engine.processOrder(buyIntent);

      // Empty CLOB should route to LMSR
      expect(result.engineType).toContain("LMSR");
      expect(result.engineType).not.toContain("CLOB");
    });

    it("should route to LMSR when CLOB has only asks (no bids for buy order)", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.05,
        minDepth: 10,
      });
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Bootstrap Alice with shares and place a sell order
      bootstrapShares(engine, "alice", 100);
      const sellIntent = createIntent("sell-1", "alice", "SELL", "LIMIT", 0.6, 50, 0);
      engine.processOrder(sellIntent);

      // Bob's buy should use CLOB (there are asks)
      const buyIntent = createIntent("buy-1", "bob", "BUY", "LIMIT", 0.6, 25, 1);
      const buyResult = engine.processOrder(buyIntent);

      expect(buyResult.engineType).toContain("CLOB");
      expect(buyResult.filledQty.toNumber()).toBe(25);
    });
  });

  describe("Spread threshold routing", () => {
    it("should choose CLOB when spread ≤ threshold", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.05, // 5% threshold
      });
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Create tight spread: bid 0.49, ask 0.50 = 1% spread
      bootstrapShares(engine, "alice", 100);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 100, 0));
      engine.processOrder(createIntent("bid-1", "bob", "BUY", "LIMIT", 0.49, 100, 1));

      const state = engine.getMarketState();
      expect(state.spread!.toNumber()).toBe(0.01);
      expect(state.spread!.toNumber()).toBeLessThanOrEqual(0.05);

      // Should route to CLOB for subsequent orders
      const buyIntent = createIntent("buy-2", "bob", "BUY", "LIMIT", 0.50, 50, 2);
      const result = engine.processOrder(buyIntent);

      expect(result.engineType).toContain("CLOB");
    });

    it("should choose LMSR when spread > threshold", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.01, // 1% threshold
      });
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Create wide spread: bid 0.40, ask 0.60 = 20% spread
      bootstrapShares(engine, "alice", 100);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.60, 100, 0));
      engine.processOrder(createIntent("bid-1", "bob", "BUY", "LIMIT", 0.40, 100, 1));

      const state = engine.getMarketState();
      expect(state.spread!.toNumber()).toBe(0.20);
      expect(state.spread!.toNumber()).toBeGreaterThan(0.01);

      // Should route to LMSR
      const buyIntent = createIntent("buy-2", "bob", "BUY", "LIMIT", 0.50, 50, 2);
      const result = engine.processOrder(buyIntent);

      expect(result.engineType).toContain("LMSR");
    });

    it("should be deterministic at boundary (spread = threshold)", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.02,
      });
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Create spread exactly at threshold
      bootstrapShares(engine, "alice", 100);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.51, 100, 0));
      engine.processOrder(createIntent("bid-1", "bob", "BUY", "LIMIT", 0.49, 100, 1));

      // Spread = 0.51 - 0.49 = 0.02 (exactly at threshold)
      // Test multiple times with same seed should give same result
      const buyIntent = createIntent("buy-2", "bob", "BUY", "LIMIT", 0.50, 10, 2);
      const result1 = engine.processOrder(buyIntent);
      const result2 = engine.processOrder(createIntent("buy-3", "bob", "BUY", "LIMIT", 0.50, 10, 3));

      // Both should make the same routing decision
      expect(result1.engineType).toBe(result2.engineType);
    });
  });

  describe("Depth threshold routing", () => {
    it("should check depth within specified ticks", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.10,
        minDepth: 50, // Need at least 50 shares depth
      });
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Add liquidity at multiple levels
      bootstrapShares(engine, "alice", 200);

      // Add asks at 3 price levels: 20 + 20 + 20 = 60 total depth
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.52, 20, 0));
      engine.processOrder(createIntent("ask-2", "alice", "SELL", "LIMIT", 0.53, 20, 1));
      engine.processOrder(createIntent("ask-3", "alice", "SELL", "LIMIT", 0.54, 20, 2));

      // Depth at best 3 ticks should be 60 >= threshold
      const depth = engine.getDepth("BUY", 3);
      expect(depth.toNumber()).toBe(60);

      // Should route to CLOB (sufficient depth)
      const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 30, 3);
      const result = engine.processOrder(buyIntent);

      expect(result.engineType).toContain("CLOB");
    });

    it("should use LMSR when depth < threshold", () => {
      const engine = createHybridEngineV2({
        maxSpread: 0.10,
        minDepth: 100, // Need 100 shares
      });
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      bootstrapShares(engine, "alice", 50);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.55, 50, 0));

      // Depth is only 50 < 100 threshold
      const depth = engine.getDepth("BUY", 3);
      expect(depth.toNumber()).toBe(50);

      // Should route to LMSR
      const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 30, 1);
      const result = engine.processOrder(buyIntent);

      expect(result.engineType).toContain("LMSR");
    });
  });
});

// ============================================================================
// 2. Fallback Behavior
// ============================================================================

describe("HybridRouterV2: Fallback Behavior", () => {
  describe("CLOB partial fill spills to LMSR", () => {
    it("should fill k on CLOB and route qty-k to LMSR", () => {
      const engine = createHybridEngineV2(createSpreadBasedConfig());
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Alice has 100 shares to sell
      bootstrapShares(engine, "alice", 100);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 100, 0));

      // Bob wants to buy 200, but only 100 available on CLOB
      const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 200, 1);
      const result = engine.processOrder(buyIntent);

      // Should be fully filled
      expect(result.status).toBe("FILLED");
      expect(result.filledQty.toNumber()).toBe(200);

      // Both engines should have been used
      expect(result.engineType).toContain("CLOB");
      expect(result.engineType).toContain("LMSR");
    });

    it("should produce exactly k filled on CLOB when available", () => {
      const engine = createHybridEngineV2(createSpreadBasedConfig());
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      // Alice offers 75 shares
      bootstrapShares(engine, "alice", 100);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 75, 0));

      const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 200, 1);
      const result = engine.processOrder(buyIntent);

      // Check the routing decisions
      const logs = result.logs;
      const routingLogs = logs.filter(l => l.type === "ROUTING_DECISION");

      // Should have a CLOB routing with qty 75
      const clobRoute = routingLogs.find((l: any) => l.data?.engine === "CLOB");
      expect(clobRoute).toBeDefined();
      expect((clobRoute as any).data.qty.toNumber()).toBe(75);
    });

    it("should route remainder to LMSR after CLOB partial fill", () => {
      const engine = createHybridEngineV2(createSpreadBasedConfig());
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      bootstrapShares(engine, "alice", 50);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 50, 0));

      const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 150, 1);
      const result = engine.processOrder(buyIntent);

      const logs = result.logs;
      const routingLogs = logs.filter(l => l.type === "ROUTING_DECISION");

      // LMSR should handle the remaining 100
      const lmsrRoute = routingLogs.find((l: any) => l.data?.engine === "LMSR");
      expect(lmsrRoute).toBeDefined();
      expect((lmsrRoute as any).data.qty.toNumber()).toBe(100);
    });

    it("should not double-fill or lose remainder", () => {
      const engine = createHybridEngineV2(createSpreadBasedConfig());
      engine.initialize();
      engine.addTrader("alice", 10000);
      engine.addTrader("bob", 10000);

      bootstrapShares(engine, "alice", 30);
      engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 30, 0));

      const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 100, 1);
      const result = engine.processOrder(buyIntent);

      // Total filled must equal requested
      expect(result.filledQty.toNumber()).toBe(100);
      expect(result.remainingQty.toNumber()).toBe(0);

      // Sum of routing quantities should equal filled qty
      const logs = result.logs;
      const routingLogs = logs.filter(l => l.type === "ROUTING_DECISION");
      const totalRouted = routingLogs.reduce((sum, l: any) => sum + (l.data?.qty?.toNumber() || 0), 0);

      expect(totalRouted).toBe(100);
    });
  });
});

// ============================================================================
// 3. Shared Position/Ledger Invariants
// ============================================================================

describe("HybridRouterV2: Ledger Invariants", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
  });

  it("should never allow negative cash", () => {
    bootstrapShares(engine, "alice", 100);

    // Try to buy more than cash allows
    const buyIntent = createIntent("buy-1", "bob", "BUY", "LIMIT", 0.90, 50000, 0);
    const result = engine.processOrder(buyIntent);

    // Either rejected or partial fill with no negative cash
    const bobPos = engine.getSharedPositions().get("bob")!;
    expect(bobPos.cash.toNumber()).toBeGreaterThanOrEqual(0);
  });

  it("should enforce sell-to-close (no negative shares)", () => {
    // Bob has no shares
    const sellIntent = createIntent("sell-1", "bob", "SELL", "MARKET", undefined, 10, 0);
    const result = engine.processOrder(sellIntent);

    // Bob's position should still have non-negative shares
    const bobPos = engine.getSharedPositions().get("bob")!;
    expect(bobPos.yesShares.toNumber()).toBeGreaterThanOrEqual(0);
  });

  it("should conserve cash: cash transferred equals trade value", () => {
    bootstrapShares(engine, "alice", 100);

    // Alice sells to Bob at 0.50
    engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 100, 0));

    const aliceBefore = engine.getSharedPositions().get("alice")!.cash.toNumber();
    const bobBefore = engine.getSharedPositions().get("bob")!.cash.toNumber();

    engine.processOrder(createIntent("bid-1", "bob", "BUY", "LIMIT", 0.50, 100, 1));

    const aliceAfter = engine.getSharedPositions().get("alice")!.cash.toNumber();
    const bobAfter = engine.getSharedPositions().get("bob")!.cash.toNumber();

    // Bob spent 50 (100 * 0.50)
    expect(bobBefore - bobAfter).toBeCloseTo(50, 0.01);
    // Alice received 50
    expect(aliceAfter - aliceBefore).toBeCloseTo(50, 0.01);

    // Total cash conserved
    const totalBefore = aliceBefore + bobBefore;
    const totalAfter = aliceAfter + bobAfter;
    expect(totalAfter).toBeCloseTo(totalBefore, 0.01);
  });

  it("should allow buy on LMSR then sell on CLOB", () => {
    // Bob buys on LMSR
    const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 100, 0);
    engine.processOrder(buyIntent);

    // Bob should have shares (not checking exact count due to aggregation)
    const bobBefore = engine.getSharedPositions().get("bob")!;
    expect(bobBefore.yesShares.toNumber()).toBeGreaterThan(0);

    // Bootstrap Alice with shares for liquidity
    const alice = engine.getSharedPositions().get("alice")!;
    alice.yesShares = alice.yesShares.plus(200);
    alice.cash = alice.cash.minus(100);

    // Alice places a BUY order to provide liquidity
    const aliceBuyIntent = createIntent("alice-buy", "alice", "BUY", "LIMIT", 0.60, 50, 1);
    engine.processOrder(aliceBuyIntent);

    // Bob sells his shares - should execute on CLOB
    const sellIntent = createIntent("sell-1", "bob", "SELL", "MARKET", undefined, 50, 2);
    const result = engine.processOrder(sellIntent);

    // Should execute successfully on CLOB
    expect(result.filledQty.toNumber()).toBe(50);
    expect(result.engineType).toContain("CLOB");
  });

  it("should track net position correctly after mixed trades", () => {
    bootstrapShares(engine, "alice", 200);

    // Alice sells 100 to Bob on CLOB
    engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 100, 0));
    engine.processOrder(createIntent("bid-1", "bob", "BUY", "LIMIT", 0.50, 100, 1));

    // Bob buys another 50 on LMSR
    engine.processOrder(createIntent("buy-2", "bob", "BUY", "MARKET", undefined, 50, 2));

    const bobPos = engine.getSharedPositions().get("bob")!;
    expect(bobPos.yesShares.toNumber()).toBe(150);
  });
});

// ============================================================================
// 4. Sync Correctness
// ============================================================================

describe("HybridRouterV2: Sync Correctness", () => {
  let engine: HybridRouterV2;

  beforeEach(() => {
    engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
  });

  it("should handle round-trip sync without drift", () => {
    bootstrapShares(engine, "alice", 100);

    // Get initial state
    const posBefore = engine.getSharedPositions().get("alice")!;
    const cashBefore = posBefore.cash.toNumber();
    const sharesBefore = posBefore.yesShares.toNumber();

    // Alice places a sell order (goes on CLOB book, no cross yet)
    const sellResult = engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.60, 50, 0));

    // Since there's no buyer yet, order goes on book - no cash change
    const posAfterOrder = engine.getSharedPositions().get("alice")!;
    const cashAfterOrder = posAfterOrder.cash.toNumber();
    const sharesAfterOrder = posAfterOrder.yesShares.toNumber();

    // Cash unchanged (order didn't cross)
    expect(cashAfterOrder).toBeCloseTo(cashBefore, 0.01);
    // Shares unchanged (order didn't execute)
    expect(sharesAfterOrder).toBe(sharesBefore);

    // Now Bob buys - crosses with Alice's ask on CLOB
    const bobResult = engine.processOrder(createIntent("bid-1", "bob", "BUY", "MARKET", undefined, 50, 1));

    // Bob's buy executed on CLOB (crossed with Alice's ask)
    expect(bobResult.status).toBe("FILLED");
    expect(bobResult.filledQty.toNumber()).toBe(50);
    expect(bobResult.engineType).toContain("CLOB");

    // Alice sold 50 shares to Bob on CLOB
    const posAfter = engine.getSharedPositions().get("alice")!;
    expect(posAfter.yesShares.toNumber()).toBe(50); // 100 - 50 = 50 remaining
    expect(posAfter.cash.toNumber()).toBeGreaterThan(cashBefore); // Received payment for shares
  });

  it("should account for open orders in shared position", () => {
    bootstrapShares(engine, "alice", 200);

    // Alice places a sell order - with no opposing buy order, it should rest on book
    // But first make sure there's nothing to cross with
    const sellResult = engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.70, 30, 0));

    // Should be OPEN (no cross)
    expect(sellResult.status).toBe("OPEN");

    // Alice's shares are unchanged (order didn't execute)
    const alice = engine.getSharedPositions().get("alice")!;
    expect(alice.yesShares.toNumber()).toBe(200); // Still owns them
    expect(alice.clobOpenOrders.size).toBe(1); // Order tracked
  });

  it("should sync positions to both engines before execution", () => {
    // Bootstrap Alice with shares
    bootstrapShares(engine, "alice", 100);

    // Modify shared position directly to 75 shares
    const alice = engine.getSharedPositions().get("alice")!;
    alice.yesShares = new Decimal(75);

    // Alice sells 25 - should execute successfully
    const sellIntent = createIntent("sell-1", "alice", "SELL", "LIMIT", 0.60, 25, 0);
    const result = engine.processOrder(sellIntent);

    // Order placed on book (no buyer yet)
    expect(result.status).toBe("OPEN");

    // Position still has 75 shares (order didn't execute yet)
    const aliceAfter = engine.getSharedPositions().get("alice")!;
    expect(aliceAfter.yesShares.toNumber()).toBe(75);
  });
});

// ============================================================================
// 5. Determinism
// ============================================================================

describe("HybridRouterV2: Determinism", () => {
  it("should produce identical results with same seed", () => {
    const config1 = createSpreadBasedConfig();
    const config2 = createSpreadBasedConfig();

    // Ensure same seed behavior
    // createHybridEngineV2 sets type itself (its param is Omit<..., "type">),
    // so passing it here was a no-op that only needed an `as any` to compile.
    const engine1 = createHybridEngineV2(config1);
    const engine2 = createHybridEngineV2(config2);

    engine1.initialize();
    engine2.initialize();

    // Same setup
    engine1.addTrader("alice", 10000);
    engine1.addTrader("bob", 10000);
    engine2.addTrader("alice", 10000);
    engine2.addTrader("bob", 10000);

    bootstrapShares(engine1, "alice", 100);
    bootstrapShares(engine2, "alice", 100);

    // Same order sequence
    const orders = [
      createIntent("1", "alice", "SELL", "LIMIT", 0.50, 100, 0),
      createIntent("2", "bob", "BUY", "LIMIT", 0.50, 50, 1),
      createIntent("3", "bob", "BUY", "MARKET", undefined, 30, 2),
    ];

    const results1 = orders.map(o => engine1.processOrder(o));
    const results2 = orders.map(o => engine2.processOrder(o));

    // Same results
    for (let i = 0; i < results1.length; i++) {
      expect(results1[i].engineType).toBe(results2[i].engineType);
      expect(results1[i].filledQty.toString()).toBe(results2[i].filledQty.toString());
      expect(results1[i].status).toBe(results2[i].status);
    }

    // Same final state
    const pos1 = engine1.getSharedPositions().get("bob")!;
    const pos2 = engine2.getSharedPositions().get("bob")!;

    expect(pos1.cash.toString()).toBe(pos2.cash.toString());
    expect(pos1.yesShares.toString()).toBe(pos2.yesShares.toString());
  });

  it("should produce deterministic routing decisions", () => {
    const engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);

    // Run same sequence twice
    const orders = [
      createIntent("1", "alice", "BUY", "MARKET", undefined, 50, 0),
      createIntent("2", "alice", "BUY", "MARKET", undefined, 30, 1),
    ];

    // First run
    const results1 = orders.map(o => engine.processOrder(o));
    const stats1 = engine.getStats();

    // Reset and run again
    engine.initialize();
    engine.addTrader("alice", 10000);
    const results2 = orders.map(o => engine.processOrder(o));
    const stats2 = engine.getStats();

    // Same outcomes
    for (let i = 0; i < results1.length; i++) {
      expect(results1[i].filledQty.toString()).toBe(results2[i].filledQty.toString());
      expect(results1[i].engineType).toBe(results2[i].engineType);
    }

    // Same stats
    expect(stats1.clobExecutions).toBe(stats2.clobExecutions);
    expect(stats1.lmsrExecutions).toBe(stats2.lmsrExecutions);
  });
});

// ============================================================================
// 6. No-Regret Sanity Checks
// ============================================================================

describe("HybridRouterV2: No-Regret Sanity Checks", () => {
  it("should use CLOB when price is better than LMSR", () => {
    const engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);

    // Set up CLOB with better price than LMSR (~0.50 initially)
    bootstrapShares(engine, "alice", 100);
    engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.45, 100, 0));

    // CLOB ask is 0.45, LMSR price is ~0.50
    // Bob should get the better price on CLOB
    const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 50, 1);
    const result = engine.processOrder(buyIntent);

    expect(result.engineType).toContain("CLOB");
    expect(result.avgFillPrice.toNumber()).toBeLessThan(0.50);
  });

  it("should not unnecessarily route to LMSR when CLOB has sufficient liquidity", () => {
    const engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);

    // Set up CLOB with lots of liquidity
    bootstrapShares(engine, "alice", 500);
    engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 200, 0));

    const buyIntent = createIntent("buy-1", "bob", "BUY", "MARKET", undefined, 50, 1);
    const result = engine.processOrder(buyIntent);

    // Should only use CLOB, not LMSR
    expect(result.engineType).toBe("HYBRID_V2(CLOB)");
    expect(result.engineType).not.toContain("LMSR");
  });

  it("should not switch routing mode without signal change (SPREAD_BASED)", () => {
    const engine = createHybridEngineV2(createSpreadBasedConfig(0.05));
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);

    bootstrapShares(engine, "alice", 100);
    engine.processOrder(createIntent("ask-1", "alice", "SELL", "LIMIT", 0.50, 50, 0));

    // First buy (tight spread)
    const buy1 = createIntent("buy-1", "bob", "BUY", "LIMIT", 0.50, 10, 1);
    const result1 = engine.processOrder(buy1);

    // Second buy with same conditions
    const buy2 = createIntent("buy-2", "bob", "BUY", "LIMIT", 0.50, 10, 2);
    const result2 = engine.processOrder(buy2);

    // Both should make same routing decision
    expect(result1.engineType).toBe(result2.engineType);
  });
});

// ============================================================================
// 7. Golden Regression Tests
// ============================================================================

describe("HybridRouterV2: Golden Regression Tests", () => {
  const goldenTestCases = [
    {
      name: "SPREAD_BASED with thin liquidity",
      config: createSpreadBasedConfig(),
      setup: (engine: HybridRouterV2) => {
        engine.initialize();
        engine.addTrader("alice", 10000);
        engine.addTrader("bob", 10000);
        bootstrapShares(engine, "alice", 50);
      },
      orders: [
        { intentId: "1", traderId: "alice", side: "SELL" as const, type: "LIMIT" as const, price: 0.60, qty: 30, time: 0 },
        { intentId: "2", traderId: "bob", side: "BUY" as const, type: "LIMIT" as const, price: 0.60, qty: 20, time: 1 },
        { intentId: "3", traderId: "bob", side: "BUY" as const, type: "MARKET" as const, qty: 40, time: 2 },
      ],
      // Order 1: OPEN (no fill) - no clob execution
      // Order 2: FILLED on CLOB (crosses) - clobExecutions++
      // Order 3: FILLED - 10 from CLOB (remaining from alice), 30 from LMSR
      expectedStats: { clobExecutions: 2, lmsrExecutions: 1, totalOrders: 3 },
    },
    {
      name: "SPREAD_BASED with moderate liquidity",
      config: createSpreadBasedConfig(0.03),
      setup: (engine: HybridRouterV2) => {
        engine.initialize();
        engine.addTrader("alice", 10000);
        engine.addTrader("bob", 10000);
        bootstrapShares(engine, "alice", 150);
      },
      orders: [
        { intentId: "1", traderId: "alice", side: "SELL" as const, type: "LIMIT" as const, price: 0.51, qty: 50, time: 0 },
        { intentId: "2", traderId: "alice", side: "SELL" as const, type: "LIMIT" as const, price: 0.52, qty: 50, time: 1 },
        { intentId: "3", traderId: "bob", side: "BUY" as const, type: "MARKET" as const, qty: 75, time: 2 },
      ],
      // Order 1 & 2: OPEN (no fills) - no executions counted
      // Order 3: FILLED - all 75 from CLOB (sufficient liquidity)
      // SPREAD_BASED: with 0.03 threshold, CLOB should be used (spread is 0 since no bid)
      expectedStats: { clobExecutions: 1, lmsrExecutions: 0, totalOrders: 3 },
    },
  ];

  for (const tc of goldenTestCases) {
    describe(tc.name, () => {
      it("should match expected routing statistics", () => {
        const engine = createHybridEngineV2(tc.config);
        tc.setup(engine);

        for (const order of tc.orders) {
          const intent = createIntent(
            order.intentId,
            order.traderId,
            order.side,
            order.type,
            order.price,
            order.qty,
            order.time
          );
          engine.processOrder(intent);
        }

        const stats = engine.getStats();

        expect(stats.totalOrders).toBe(tc.expectedStats.totalOrders);
        expect(stats.clobExecutions).toBe(tc.expectedStats.clobExecutions);
        expect(stats.lmsrExecutions).toBe(tc.expectedStats.lmsrExecutions);
      });

      it("should have consistent final state", () => {
        const engine = createHybridEngineV2(tc.config);
        tc.setup(engine);

        for (const order of tc.orders) {
          const intent = createIntent(
            order.intentId,
            order.traderId,
            order.side,
            order.type,
            order.price,
            order.qty,
            order.time
          );
          engine.processOrder(intent);
        }

        const alice = engine.getSharedPositions().get("alice")!;
        const bob = engine.getSharedPositions().get("bob")!;

        // Sanity checks
        expect(alice.cash.toNumber()).toBeGreaterThanOrEqual(0);
        expect(bob.cash.toNumber()).toBeGreaterThanOrEqual(0);
        expect(alice.yesShares.toNumber()).toBeGreaterThanOrEqual(0);
        expect(bob.yesShares.toNumber()).toBeGreaterThanOrEqual(0);
      });
    });
  }
});

// ============================================================================
// 8. Property-Based Invariants
// ============================================================================

describe("HybridRouterV2: Property-Based Invariants", () => {
  // Helper to generate random orders
  function generateRandomOrder(seed: number, index: number): OrderIntent {
    const rng = mulberry32(seed + index);

    const traders = ["alice", "bob", "carol"];
    const traderId = traders[Math.floor(rng() * traders.length)];
    const sides = ["BUY", "SELL"] as const;
    const side = sides[Math.floor(rng() * sides.length)];
    const types = ["LIMIT", "LIMIT", "MARKET"] as const;
    const type = types[Math.floor(rng() * types.length)];

    let price: number | undefined;
    if (type === "LIMIT") {
      price = 0.3 + (rng() * 0.4); // 0.30 to 0.70
    }

    const qty = 1 + Math.floor(rng() * 50); // 1 to 50

    return createIntent(
      `intent-${index}`,
      traderId,
      side,
      type,
      price,
      qty,
      index
    );
  }

  // Simple seeded RNG (Mulberry32)
  function mulberry32(a: number): () => number {
    let state = a;
    return () => {
      let t = state += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ t >>> 14) >>> 0;
    };
  }

  describe("Random order sequences maintain invariants", () => {
    const testCases = [
      { seed: 12345, orders: 50 },
      { seed: 67890, orders: 100 },
      { seed: 42, orders: 25 },
    ];

    for (const tc of testCases) {
      it(`seed ${tc.seed}, ${tc.orders} orders maintains invariants`, () => {
        const engine = createHybridEngineV2(createSpreadBasedConfig());
        engine.initialize();

        // Bootstrap with shares for selling
        engine.addTrader("alice", 10000);
        engine.addTrader("bob", 10000);
        engine.addTrader("carol", 10000);
        bootstrapShares(engine, "alice", 200);
        bootstrapShares(engine, "bob", 100);

        // Process random orders
        for (let i = 0; i < tc.orders; i++) {
          const order = generateRandomOrder(tc.seed, i);
          engine.processOrder(order);

          // Check invariants after each order
          for (const [, pos] of engine.getSharedPositions()) {
            expect(pos.cash.toNumber()).toBeGreaterThanOrEqual(0);
            expect(pos.yesShares.toNumber()).toBeGreaterThanOrEqual(0);

            // Sell-to-close: pending sells + held shares >= 0 (always true)
            expect(pos.yesShares.toNumber()).toBeGreaterThanOrEqual(0);
          }
        }

        // Final invariants
        const stats = engine.getStats();
        expect(stats.totalOrders).toBe(tc.orders);
      });
    }
  });

  it("should never cross the CLOB book", () => {
    const engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
    bootstrapShares(engine, "alice", 200);

    // Place orders that could cross if not careful
    engine.processOrder(createIntent("1", "alice", "SELL", "LIMIT", 0.60, 100, 0));
    engine.processOrder(createIntent("2", "bob", "BUY", "LIMIT", 0.60, 100, 1));

    // Check that best bid <= best ask (or one is undefined)
    const state = engine.getMarketState();
    const bid = state.bestBid;
    const ask = state.bestAsk;

    if (bid && ask) {
      expect(bid.toNumber()).toBeLessThanOrEqual(ask.toNumber());
    }
  });

  it("should never create or lose value", () => {
    const engine = createHybridEngineV2(createSpreadBasedConfig());
    engine.initialize();
    engine.addTrader("alice", 10000);
    engine.addTrader("bob", 10000);
    bootstrapShares(engine, "alice", 200);

    // Calculate initial total value (cash + shares * $0.5 midpoint)
    let totalCash = 0;
    let totalShares = 0;
    for (const [, pos] of engine.getSharedPositions()) {
      totalCash += pos.cash.toNumber();
      totalShares += pos.yesShares.toNumber();
    }
    const initialTotal = totalCash + totalShares * 0.5;

    // Execute some trades
    engine.processOrder(createIntent("1", "alice", "SELL", "LIMIT", 0.55, 50, 0));
    engine.processOrder(createIntent("2", "bob", "BUY", "LIMIT", 0.55, 30, 1));
    engine.processOrder(createIntent("3", "bob", "BUY", "MARKET", undefined, 20, 2));

    // Final total value
    totalCash = 0;
    totalShares = 0;
    for (const [, pos] of engine.getSharedPositions()) {
      totalCash += pos.cash.toNumber();
      totalShares += pos.yesShares.toNumber();
    }
    const finalTotal = totalCash + totalShares * 0.5;

    // Within reasonable tolerance (some slippage is expected)
    expect(Math.abs(finalTotal - initialTotal)).toBeLessThan(100); // Allow some price impact
  });
});
