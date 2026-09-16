/**
 * Deterministic Simulation Runner (Replay Machine)
 *
 * Takes a seed + scenario config, generates a stream of order intents,
 * feeds them into a chosen engine, and records logs/state/metrics uniformly.
 *
 * Guarantees: same seed + same config = identical outputs (NFR2).
 */

import { Decimal } from "decimal.js";
import {
  UnifiedEngine,
  OrderIntent,
  ExecutionResult,
  MarketStateSnapshot,
  LogEntry,
  TraderState,
  Outcome,
  Side,
  OrderType,
  calcMidPrice,
  calcSlippage,
  calcPriceImpact,
} from "./engine-common";

// ============================================================================
// Scenario Configuration
// ============================================================================

/**
 * Scenario type determines workload generation
 */
export type ScenarioType =
  | "THIN_LIQUIDITY"
  | "THICK_LIQUIDITY"
  | "SHOCK"
  | "CUSTOM";

/**
 * Scenario configuration
 */
export interface ScenarioConfig {
  /** Scenario type */
  type: ScenarioType;
  /** Random seed for reproducibility */
  seed: number;
  /** Number of traders */
  numTraders: number;
  /** Initial cash per trader */
  initialCash: number;
  /** Number of order intents to generate */
  numOrders: number;
  /** Time window for orders (ms) */
  timeWindow: number;
  /** Base arrival rate (orders per second) */
  baseArrivalRate: number;
  /** For THIN/THICK: order size distribution params */
  orderSizeMin?: number;
  orderSizeMax?: number;
  /** For CLOB: price level distribution params */
  priceSpread?: number;
  /** For SHOCK: shock timing and magnitude */
  shockTime?: number; // When shock occurs (ms from start)
  shockMagnitude?: number; // Price jump amount
  shockProbability?: number; // Probability of shock at each step
  /** Custom order stream (for CUSTOM type) */
  customOrders?: OrderIntent[];
}

/**
 * Simulation output - complete record of a simulation run
 */
export interface SimulationOutput {
  /** Scenario config used */
  config: ScenarioConfig;
  /** Engine type used */
  engineType: string;
  /** Seed used */
  seed: number;
  /** Timestamp when simulation started */
  startTime: number;
  /** Timestamp when simulation ended */
  endTime: number;
  /** All order intents processed */
  intents: OrderIntent[];
  /** All execution results */
  results: ExecutionResult[];
  /** Market state snapshots (one per order) */
  snapshots: MarketStateSnapshot[];
  /** Final trader states */
  finalTraderStates: Map<string, TraderState>;
  /** All log entries */
  logs: LogEntry[];
  /** Computed metrics */
  metrics: SimulationMetrics;
}

/**
 * Aggregated simulation metrics
 */
export interface SimulationMetrics {
  /** Total orders submitted */
  totalOrders: number;
  /** Total orders filled (complete or partial) */
  filledOrders: number;
  /** Total volume traded */
  totalVolume: Decimal;
  /** Total value traded */
  totalValue: Decimal;
  /** Fill ratio by orders (filledOrders / totalOrders) - measures availability */
  fillRatio: Decimal;
  /** Fill ratio by volume (totalVolume / totalRequestedQty) - measures execution quality */
  volumeFillRatio: Decimal;
  /** Average slippage per order */
  avgSlippage: Decimal;
  /** Average price impact per order */
  avgPriceImpact: Decimal;
  /** Time-weighted average slippage */
  twaSlippage: Decimal;
  /** Worst slippage */
  worstSlippage: Decimal;
  /** Best slippage */
  bestSlippage: Decimal;
  /** Total price impact */
  totalPriceImpact: Decimal;
  /** Final mid price */
  finalMidPrice?: Decimal;
  /** Initial mid price */
  initialMidPrice?: Decimal;
  /** Price movement (final - initial) */
  priceMovement?: Decimal;
  /** Spread time series (for CLOB) */
  spreadSeries?: Decimal[];
  /** Depth time series (for CLOB) */
  depthSeries?: Decimal[];
  /** Price time series (for LMSR) */
  priceSeries?: Decimal[];
  /** Volume per trader */
  volumePerTrader?: Map<string, Decimal>;
}

// ============================================================================
// Seeded Random Number Generator
// ============================================================================

/**
 * Simple seeded random number generator for reproducibility
 * Uses Mulberry32 algorithm - fast and good statistical properties
 */
export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  /**
   * Generate random float in [0, 1)
   */
  random(): number {
    this.state |= 0;
    this.state = this.state + 0x6D2B79F5;
    let t = Math.imul(this.state ^ (this.state >>> 17), this.state | 0);
    t = t + Math.imul(t >>> 17, t | 0);
    t = t ^ (t + Math.imul(t << 11, t | 0));
    this.state = (this.state ^ (this.state >>> 11)) >>> 0;
    this.state = this.state + 0x6D2B79F5;
    this.state = (this.state ^ (this.state >>> 11)) >>> 0;
    this.state = this.state + Math.imul(t >>> 11, t | 0);
    this.state = this.state ^ (this.state >>> 11);
    this.state = (this.state + 0x6D2B79F5) | 0;
    this.state = (this.state ^ (this.state >>> 11)) >>> 0;

    return (this.state >>> 0) / 4294967296;
  }

  /**
   * Generate random integer in [0, max)
   */
  randomInt(max: number): number {
    return Math.floor(this.random() * max);
  }

  /**
   * Generate random integer in [min, max]
   */
  randomRange(min: number, max: number): number {
    return min + this.randomInt(max - min + 1);
  }

  /**
   * Generate random float in [min, max]
   */
  randomFloat(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  /**
   * Generate random choice from array
   */
  randomChoice<T>(arr: T[]): T {
    return arr[this.randomInt(arr.length)];
  }

  /**
   * Generate normally distributed random number (Box-Muller transform)
   */
  randomNormal(mean: number, stdDev: number): number {
    const u1 = this.random();
    const u2 = this.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return z0 * stdDev + mean;
  }

  /**
   * Generate exponentially distributed random number
   */
  randomExp(lambda: number): number {
    return -Math.log(1 - this.random()) / lambda;
  }

  /**
   * Create a new RNG with a derived seed
   */
  fork(): SeededRNG {
    return new SeededRNG(this.randomInt(2 ** 31));
  }
}

// ============================================================================
// Order Intent Generator
// ============================================================================

export class OrderIntentGenerator {
  private rng: SeededRNG;
  private config: ScenarioConfig;
  private traders: string[];
  private intentCounter: number = 0;

  constructor(config: ScenarioConfig) {
    this.config = config;
    this.rng = new SeededRNG(config.seed);
    this.traders = Array.from({ length: config.numTraders }, (_, i) => `trader-${i + 1}`);
  }

  /**
   * Generate all order intents for the scenario
   */
  generate(): OrderIntent[] {
    switch (this.config.type) {
      case "THIN_LIQUIDITY":
        return this.generateThinLiquidity();
      case "THICK_LIQUIDITY":
        return this.generateThickLiquidity();
      case "SHOCK":
        return this.generateShock();
      case "CUSTOM":
        return this.config.customOrders || [];
      default:
        return [];
    }
  }

  private createIntent(
    traderId: string,
    outcome: Outcome,
    side: Side,
    orderType: OrderType,
    price: number | undefined,
    qty: number,
    timestamp: number
  ): OrderIntent {
    this.intentCounter++;
    return {
      intentId: `intent-${this.intentCounter.toString().padStart(8, "0")}`,
      traderId,
      outcome,
      side,
      orderType,
      price,
      qty,
      timestamp,
    };
  }

  private generateThinLiquidity(): OrderIntent[] {
    const orders: OrderIntent[] = [];
    const orderSizeMin = this.config.orderSizeMin || 1;
    const orderSizeMax = this.config.orderSizeMax || 10;
    const priceSpread = this.config.priceSpread || 0.10;
    const numOrders = this.config.numOrders;
    const timeWindow = this.config.timeWindow;
    const arrivalRate = this.config.baseArrivalRate * 0.5; // Lower arrival rate

    let currentTime = 0;

    // Phase 1: Seed initial liquidity with ONLY BUY orders
    // This builds the bid side without needing traders to have shares
    const seedOrders = Math.min(Math.floor(numOrders * 0.15), 15);

    for (let i = 0; i < seedOrders; i++) {
      const traderId = this.traders[i % this.traders.length];
      const qty = this.rng.randomFloat(orderSizeMin, orderSizeMax);
      // Vary price around 0.50 to create depth
      const price = 0.50 - this.rng.randomFloat(0.01, 0.08); // Bids below 0.50

      orders.push(this.createIntent(traderId, "YES", "BUY", "LIMIT", price, qty, currentTime));
      currentTime += Math.floor(this.rng.randomExp(arrivalRate) * 300);
    }

    // Phase 2: Generate mixed orders with BUY bias
    for (let i = seedOrders; i < numOrders; i++) {
      const traderId = this.rng.randomChoice(this.traders);
      const outcome = this.rng.randomChoice<Outcome>(["YES", "NO"]);

      // Bias towards BUY (75% BUY, 25% SELL) to maintain liquidity
      const side = this.rng.random() < 0.75 ? "BUY" : "SELL";

      const orderType = this.rng.randomChoice<OrderType>(["LIMIT", "LIMIT", "MARKET"]);
      const qty = this.rng.randomFloat(orderSizeMin, orderSizeMax);

      let price: number | undefined;
      if (orderType === "LIMIT") {
        const basePrice = 0.50;
        price = this.rng.randomFloat(basePrice - priceSpread, basePrice + priceSpread);
        price = Math.max(0.01, Math.min(0.99, price));
      }

      orders.push(this.createIntent(traderId, outcome, side, orderType, price, qty, currentTime));
      currentTime += Math.floor(this.rng.randomExp(arrivalRate) * 1000);
      if (currentTime >= timeWindow) break;
    }

    return orders;
  }

  private generateThickLiquidity(): OrderIntent[] {
    const orders: OrderIntent[] = [];
    const orderSizeMin = this.config.orderSizeMin || 1;
    const orderSizeMax = this.config.orderSizeMax || 50;
    const priceSpread = this.config.priceSpread || 0.02;
    const numOrders = this.config.numOrders;
    const timeWindow = this.config.timeWindow;
    const arrivalRate = this.config.baseArrivalRate * 2.0;

    let currentTime = 0;

    // For THICK liquidity, use 100% CROSSING limit orders
    // Bids above 0.50, asks below 0.50 - these will immediately match with opposite side
    // This creates high fill ratio by ensuring every order can find a match
    for (let i = 0; i < numOrders; i++) {
      const traderId = this.traders[i % this.traders.length];
      const outcome = this.rng.randomChoice<Outcome>(["YES", "NO"]);
      const side = this.rng.random() < 0.5 ? "BUY" : "SELL";
      const qty = this.rng.randomFloat(1, 15);

      // Use crossing prices that guarantee immediate fills
      let price: number;
      if (side === "BUY") {
        // Bid above mid - will match with existing asks
        price = 0.50 + this.rng.randomFloat(0.01, 0.05);
      } else {
        // Ask below mid - will match with existing bids
        price = 0.50 - this.rng.randomFloat(0.01, 0.05);
      }

      orders.push(this.createIntent(traderId, outcome, side, "LIMIT", price, qty, currentTime));
      currentTime += Math.floor(this.rng.randomExp(arrivalRate) * 1000);
      if (currentTime >= timeWindow) break;
    }

    return orders;
  }

  private generateShock(): OrderIntent[] {
    const orders: OrderIntent[] = [];
    const numOrders = this.config.numOrders;
    const timeWindow = this.config.timeWindow;
    const shockTime = this.config.shockTime ?? Math.floor(timeWindow / 2);
    const shockMagnitude = this.config.shockMagnitude ?? 0.10;
    const shockProbability = this.config.shockProbability ?? 0.3;

    let currentTime = 0;
    let shocked = false;
    let basePrice = 0.50;
    const shockRng = this.rng.fork();

    // Phase 1: Seed with BUY orders only
    const seedOrders = Math.min(Math.floor(numOrders * 0.12), 25);

    for (let i = 0; i < seedOrders; i++) {
      const traderId = this.traders[i % this.traders.length];
      const qty = this.rng.randomFloat(1, 10);
      const price = basePrice - this.rng.randomFloat(0.01, 0.03);

      orders.push(this.createIntent(traderId, "YES", "BUY", "LIMIT", price, qty, currentTime));
      currentTime += Math.floor(this.rng.randomExp(this.config.baseArrivalRate) * 300);
    }

    // Phase 2: Mixed orders with BUY bias
    for (let i = seedOrders; i < numOrders; i++) {
      // Check for shock
      if (currentTime >= shockTime && !shocked) {
        if (shockRng.random() < shockProbability) {
          basePrice += shockMagnitude;
          shocked = true;
        }
      }

      const traderId = this.rng.randomChoice(this.traders);
      const outcome = this.rng.randomChoice<Outcome>(["YES", "NO"]);
      const side = this.rng.random() < 0.7 ? "BUY" : "SELL"; // 70% BUY
      const orderType = this.rng.randomChoice<OrderType>(["LIMIT", "LIMIT", "LIMIT", "MARKET"]);
      const qty = this.rng.randomFloat(1, 20);

      let price: number | undefined;
      if (orderType === "LIMIT") {
        const spread = 0.05;
        price = this.rng.randomFloat(basePrice - spread, basePrice + spread);
        price = Math.max(0.01, Math.min(0.99, price));
      }

      orders.push(this.createIntent(traderId, outcome, side, orderType, price, qty, currentTime));
      currentTime += Math.floor(this.rng.randomExp(this.config.baseArrivalRate) * 1000);
      if (currentTime >= timeWindow) break;
    }

    return orders;
  }
}

// ============================================================================
// Simulation Runner
// ============================================================================

export class SimulationRunner {
  private engine: UnifiedEngine;

  constructor(engine: UnifiedEngine) {
    this.engine = engine;
  }

  /**
   * Initialize all traders with starting cash from scenario config
   * For CLOB, also pre-seed some traders with shares so they can sell
   */
  private initializeTraders(config: ScenarioConfig): void {
    const generator = new OrderIntentGenerator(config);
    const traderIds = Array.from({ length: config.numTraders }, (_, i) => `trader-${i + 1}`);

    for (const traderId of traderIds) {
      this.engine.addTrader(traderId, config.initialCash);
    }

    // For CLOB-backed engines, pre-seed some traders with YES/NO shares so
    // early SELL LIMIT orders can execute. Applies to pure CLOB and to the
    // hybrid router (whose CLOB leg also needs resting inventory); pure LMSR
    // mints shares via the cost function and needs no seeding.
    const engineType = this.engine.engineType;
    const needsShareSeeding = engineType === "CLOB" || engineType === "HYBRID_V2";
    if (needsShareSeeding) {
      // Seed 30% of traders with YES shares, and 30% with NO shares
      const numYesTraders = Math.max(2, Math.floor(config.numTraders * 0.3));
      const numNoTraders = Math.max(2, Math.floor(config.numTraders * 0.3));

      for (let i = 0; i < numYesTraders; i++) {
        const traderId = traderIds[i];
        // Give them 100 YES shares (worth ~$50 at $0.50)
        this.engine.creditShares(traderId, "YES", 100);
      }

      for (let i = 0; i < numNoTraders; i++) {
        const traderId = traderIds[(i + Math.floor(config.numTraders / 2)) % config.numTraders];
        // Give them 100 NO shares
        this.engine.creditShares(traderId, "NO", 100);
      }
    }
  }

  /**
   * Run a complete simulation
   */
  async run(config: ScenarioConfig): Promise<SimulationOutput> {
    const startTime = Date.now();

    // Generate order intents
    const generator = new OrderIntentGenerator(config);
    const intents = generator.generate();

    // Initialize engine
    this.engine.initialize();
    this.engine.clearLogs();

    // Initialize all traders with starting cash
    this.initializeTraders(config);

    const results: ExecutionResult[] = [];
    const snapshots: MarketStateSnapshot[] = [];
    const allLogs: LogEntry[] = [];

    // Process each order
    for (const intent of intents) {
      // Process the order first
      const result = this.engine.processOrder(intent);
      results.push(result);

      // Get state AFTER processing - this reflects the market's current implied price
      // after incorporating the order's information
      const stateAfter = this.engine.getMarketState();
      snapshots.push({ ...stateAfter, timestamp: intent.timestamp });

      // Collect logs
      const logs = this.engine.getLogs();
      allLogs.push(...logs);
      this.engine.clearLogs();
    }

    // Get final state
    const finalState = this.engine.getMarketState();
    const finalTraderStates = this.engine.getAllTraderStates();

    // Compute metrics
    const metrics = this.computeMetrics(intents, results, snapshots, finalState);

    const endTime = Date.now();

    return {
      config,
      engineType: this.engine.engineType,
      seed: config.seed,
      startTime,
      endTime,
      intents,
      results,
      snapshots,
      finalTraderStates,
      logs: allLogs,
      metrics,
    };
  }

  /**
   * Run simulation synchronously (for scripts)
   */
  runSync(config: ScenarioConfig): SimulationOutput {
    const startTime = Date.now();

    const generator = new OrderIntentGenerator(config);
    const intents = generator.generate();

    this.engine.initialize();
    this.engine.clearLogs();

    // Initialize all traders with starting cash
    this.initializeTraders(config);

    const results: ExecutionResult[] = [];
    const snapshots: MarketStateSnapshot[] = [];
    const allLogs: LogEntry[] = [];

    for (const intent of intents) {
      // Process the order first
      const result = this.engine.processOrder(intent);
      results.push(result);

      // Collect logs from this order
      const logs = this.engine.getLogs();
      allLogs.push(...logs);
      this.engine.clearLogs();

      // Get state AFTER processing - this reflects the market's current implied price
      const stateAfter = this.engine.getMarketState();
      snapshots.push({ ...stateAfter, timestamp: intent.timestamp });
    }

    const finalState = this.engine.getMarketState();
    const finalTraderStates = this.engine.getAllTraderStates();

    const metrics = this.computeMetrics(intents, results, snapshots, finalState);

    const endTime = Date.now();

    return {
      config,
      engineType: this.engine.engineType,
      seed: config.seed,
      startTime,
      endTime,
      intents,
      results,
      snapshots,
      finalTraderStates,
      logs: allLogs,
      metrics,
    };
  }

  /**
   * Compute aggregated metrics from simulation results
   */
  private computeMetrics(
    intents: OrderIntent[],
    results: ExecutionResult[],
    snapshots: MarketStateSnapshot[],
    finalState: MarketStateSnapshot
  ): SimulationMetrics {
    const totalOrders = results.length;
    const filledOrders = results.filter(r => r.status === "FILLED" || r.status === "PARTIALLY_FILLED").length;

    let totalVolume = new Decimal(0);
    let totalValue = new Decimal(0);
    let totalSlippage = new Decimal(0);
    let totalPriceImpact = new Decimal(0);
    const slippages: Decimal[] = [];
    const priceImpacts: Decimal[] = [];
    const spreadSeries: Decimal[] = [];
    const depthSeries: Decimal[] = [];
    const priceSeries: Decimal[] = [];

    const volumePerTrader = new Map<string, Decimal>();

    for (const result of results) {
      totalVolume = totalVolume.plus(result.filledQty);
      totalValue = totalValue.plus(result.filledQty.times(result.avgFillPrice));

      if (result.slippage !== null) {
        totalSlippage = totalSlippage.plus(result.slippage.abs());
        slippages.push(result.slippage);
      }

      if (result.priceImpact !== null) {
        totalPriceImpact = totalPriceImpact.plus(result.priceImpact.abs());
        priceImpacts.push(result.priceImpact);
      }

      if (result.marketState.spread !== undefined) {
        spreadSeries.push(result.marketState.spread);
      }

      // Collect depth for both sides
      const bidDepth = result.marketState.bidDepth ?? new Decimal(0);
      const askDepth = result.marketState.askDepth ?? new Decimal(0);
      depthSeries.push(bidDepth.plus(askDepth));

      if (result.marketState.priceYes !== undefined) {
        priceSeries.push(result.marketState.priceYes);
      }

      // Track volume per trader
      const traderId = result.intent.traderId;
      const currentVol = volumePerTrader.get(traderId) ?? new Decimal(0);
      volumePerTrader.set(traderId, currentVol.plus(result.filledQty));
    }

    // Calculate fill ratio
    // For LMSR: use order-based ratio (filledOrders / totalOrders) since the cost function
    // means filledQty < requestedQty is expected behavior
    // For CLOB: use volume-based ratio as before
    let fillRatio: Decimal;
    if (this.engine.engineType === "LMSR") {
      // LMSR always executes orders but quantity may be less than requested
      // due to price impact, so we measure by % of orders executed
      fillRatio = totalOrders > 0 ? new Decimal(filledOrders).div(totalOrders) : new Decimal(0);
    } else {
      // For CLOB and others, use volume-based ratio
      fillRatio = totalOrders > 0
        ? totalVolume.div(new Decimal(intents.reduce((sum, r) => {
            const qty = r.qty ?? 0;
            const qtyNum = typeof qty === "number" ? qty : qty.toNumber();
            return sum + qtyNum;
          }, 0)))
        : new Decimal(0);
    }

    // Volume-based fill ratio (totalVolume / totalRequestedQty)
    // This measures execution quality - how much of requested quantity was actually filled
    // For LMSR, this will be < 1.0 due to price impact; for CLOB, it depends on liquidity
    const volumeFillRatio = totalOrders > 0
      ? totalVolume.div(new Decimal(intents.reduce((sum, r) => {
          const qty = r.qty ?? 0;
          const qtyNum = typeof qty === "number" ? qty : qty.toNumber();
          return sum + qtyNum;
        }, 0)))
      : new Decimal(0);

    const avgSlippage = slippages.length > 0
      ? totalSlippage.div(slippages.length)
      : new Decimal(0);

    const avgPriceImpact = priceImpacts.length > 0
      ? totalPriceImpact.div(priceImpacts.length)
      : new Decimal(0);

    const worstSlippage = slippages.length > 0
      ? Decimal.max(...slippages)
      : new Decimal(0);

    const bestSlippage = slippages.length > 0
      ? Decimal.min(...slippages)
      : new Decimal(0);

    // Time-weighted average slippage
    let twaSlippage = new Decimal(0);
    let totalWeight = new Decimal(0);
    for (let i = 0; i < slippages.length; i++) {
      const weight = new Decimal(i + 1); // More weight to later trades
      twaSlippage = twaSlippage.plus(slippages[i].times(weight));
      totalWeight = totalWeight.plus(weight);
    }
    twaSlippage = totalWeight.gt(0) ? twaSlippage.div(totalWeight) : new Decimal(0);

    const initialMidPrice = snapshots[0]?.midPrice;
    const finalMidPrice = finalState.midPrice;
    const priceMovement = initialMidPrice && finalMidPrice
      ? finalMidPrice.minus(initialMidPrice)
      : undefined;

    return {
      totalOrders,
      filledOrders,
      totalVolume,
      totalValue,
      fillRatio,
      volumeFillRatio,
      avgSlippage,
      avgPriceImpact,
      twaSlippage,
      worstSlippage,
      bestSlippage,
      totalPriceImpact,
      finalMidPrice,
      initialMidPrice,
      priceMovement,
      spreadSeries,
      depthSeries,
      priceSeries,
      volumePerTrader,
    };
  }
}

// ============================================================================
// Export Helpers
// ============================================================================

export function exportSimulationToCSV(output: SimulationOutput): string {
  const lines: string[] = [];

  // Header
  lines.push("intentId,timestamp,traderId,outcome,side,orderType,price,qty,status,avgFillPrice,slippage,priceImpact");

  // Data rows
  for (let i = 0; i < output.intents.length; i++) {
    const intent = output.intents[i];
    const result = output.results[i];

    lines.push([
      intent.intentId,
      intent.timestamp,
      intent.traderId,
      intent.outcome,
      intent.side,
      intent.orderType,
      intent.price ?? "",
      intent.qty ?? "",
      result.status,
      result.avgFillPrice.toString(),
      result.slippage?.toString() ?? "",
      result.priceImpact?.toString() ?? "",
    ].join(","));
  }

  return lines.join("\n");
}

export function exportSimulationToJSON(output: SimulationOutput): string {
  return JSON.stringify(output, (key, value) => {
    if (value instanceof Decimal) {
      return value.toString();
    }
    if (value instanceof Map) {
      return Object.fromEntries(value.entries());
    }
    return value;
  }, 2);
}
