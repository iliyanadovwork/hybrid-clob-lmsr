"use client";

import { useState, useTransition, useMemo, useCallback } from "react";
import { Decimal } from "decimal.js";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  SimulationRunner,
  ScenarioConfig,
  ScenarioType,
  SimulationOutput,
} from "@/lib/simulation";
import {
  createEngine,
  createHybridEngine,
  createHybridConfig,
} from "@/lib/engine-adapters";
import type { LogEntry, UnifiedEngine } from "@/lib/engine-common";

// ============================================================================
// Types
// ============================================================================

type EngineKey = "CLOB" | "LMSR" | "HYBRID";

const ENGINES: EngineKey[] = ["CLOB", "LMSR", "HYBRID"];
const SCENARIOS: ScenarioType[] = ["THIN_LIQUIDITY", "THICK_LIQUIDITY", "SHOCK"];
const SHOCK_TIME_MS = 5000;
const RECOVERY_TOLERANCE = 0.02;
const RECOVERY_WINDOW = 5;
// Minimum valid post-shock mid samples before recoveryTime is meaningful.
// Below this, the "steady state" estimate collapses to ~1 sample and the
// first RECOVERY_WINDOW trivially matches, making engines with sparse
// two-sided snapshots (e.g. CLOB under shock) falsely look like they
// recovered instantly. Report N/A instead.
const RECOVERY_MIN_POST_MIDS = 20;

const ENGINE_COLORS: Record<EngineKey, string> = {
  CLOB: "#2563eb",
  LMSR: "#9333ea",
  HYBRID: "#059669",
};

interface BaseScenarioParams {
  numTraders: number;
  initialCash: number;
  numOrders: number;
  timeWindow: number;
  baseArrivalRate: number;
  orderSizeMin: number;
  orderSizeMax: number;
  priceSpread: number;
}

interface EngineParams {
  tickSize: number;
  bParam: number;
  spreadThreshold: number;
  depthThreshold: number;
  depthTicks: number;
}

interface SweepTask {
  scenario: ScenarioType;
  engine: EngineKey;
  seed: number;
}

interface RunRecord {
  scenario: ScenarioType;
  engine: EngineKey;
  seed: number;
  output: SimulationOutput;
}

// Rich metrics row — one per (scenario, engine) cell
interface MetricsRow {
  scenario: ScenarioType;
  engine: EngineKey;
  seedCount: number;

  // Headline
  volumeFillRatio: number;
  avgAbsSlippage: number | null;
  avgAbsPriceImpact: number | null;
  executedVolume: number;
  priceStability: number | null; // stdev of quoted mid series (null when < 2 valid mids)

  // Market quality (null = structurally N/A)
  avgSpread: number | null;
  avgDepth: number | null;
  bestSpread: number | null;
  worstSpread: number | null;

  // Shock / resiliency (null when scenario != SHOCK or N/A for engine)
  maxDislocation: number | null;
  recoveryTime: number | null;
  recovered: boolean | null;
  postShockAvgSpread: number | null;
  postShockFillRatio: number | null;

  // Hybrid-only diagnostics
  clobFirstShare: number | null;
  lmsrFirstShare: number | null;
  fallbackRate: number | null;

  // Derived vs baselines (filled in second pass)
  completionGainVsClob: number | null;
  slippagePenaltyVsClob: number | null;
  slippagePenaltyVsLmsr: number | null;

  // Extras kept for export
  fillRatio: number;
  totalValue: number;
  finalMidPrice: number | null;
  priceMovement: number | null;
}

interface TimeSeriesPoint {
  timestamp: number;
  midPrice: number | null;
  spread: number | null;
  bidDepth: number | null;
  askDepth: number | null;
}

type MergedChartPoint = {
  idx: number;
  timestamp: number;
} & Partial<Record<string, number | null>>;

interface ComparisonOutput {
  baseScenario: BaseScenarioParams;
  engineParams: EngineParams;
  scenarios: ScenarioType[];
  engines: EngineKey[];
  seeds: number[];
  runs: RunRecord[];
  metrics: MetricsRow[];
  chartSeries: Record<ScenarioType, MergedChartPoint[]>;
  createdAt: number;
}

// ============================================================================
// Pure helpers
// ============================================================================

function engineHasOrderBook(engine: EngineKey): boolean {
  return engine === "CLOB" || engine === "HYBRID";
}

function buildSweep(
  scenarios: ScenarioType[],
  engines: EngineKey[],
  seeds: number[]
): SweepTask[] {
  const tasks: SweepTask[] = [];
  for (const scenario of scenarios) {
    for (const engine of engines) {
      for (const seed of seeds) {
        tasks.push({ scenario, engine, seed });
      }
    }
  }
  return tasks;
}

function buildScenarioConfigFor(
  scenario: ScenarioType,
  seed: number,
  base: BaseScenarioParams
): ScenarioConfig {
  const config: ScenarioConfig = {
    type: scenario,
    seed,
    numTraders: base.numTraders,
    initialCash: base.initialCash,
    numOrders: base.numOrders,
    timeWindow: base.timeWindow,
    baseArrivalRate: base.baseArrivalRate,
    orderSizeMin: base.orderSizeMin,
    orderSizeMax: base.orderSizeMax,
    priceSpread: base.priceSpread,
  };
  if (scenario === "SHOCK") {
    config.shockTime = SHOCK_TIME_MS;
    config.shockMagnitude = 0.15;
    config.shockProbability = 0.3;
  }
  return config;
}

function createEngineFor(engine: EngineKey, params: EngineParams): UnifiedEngine {
  if (engine === "HYBRID") {
    const hybridConfig = createHybridConfig({
      spreadThreshold: params.spreadThreshold,
      depthThreshold: params.depthThreshold,
      depthTicks: params.depthTicks,
      b: params.bParam,
      tickSize: params.tickSize,
    });
    return createHybridEngine(hybridConfig);
  }
  if (engine === "CLOB") {
    return createEngine("CLOB", { type: "CLOB", tickSize: params.tickSize });
  }
  return createEngine("LMSR", { type: "LMSR", liquidity: params.bParam });
}

function extractTimeSeries(output: SimulationOutput): TimeSeriesPoint[] {
  return output.snapshots.map((s) => ({
    timestamp: s.timestamp,
    midPrice: s.midPrice?.toNumber() ?? null,
    spread: s.spread?.toNumber() ?? null,
    bidDepth: s.bidDepth?.toNumber() ?? null,
    askDepth: s.askDepth?.toNumber() ?? null,
  }));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function meanOrNull(xs: Array<number | null | undefined>): number | null {
  const f = xs.filter(
    (x): x is number => x !== null && x !== undefined && Number.isFinite(x)
  );
  if (f.length === 0) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}

// ---- Per-run metric helpers -------------------------------------------------

function priceStability(output: SimulationOutput): number | null {
  const mids = output.snapshots
    .map((s) => s.midPrice?.toNumber())
    .filter((x): x is number => x !== undefined && Number.isFinite(x));
  if (mids.length < 2) return null;
  return stdev(mids);
}

function spreadStats(
  output: SimulationOutput,
  engine: EngineKey
): { avg: number | null; best: number | null; worst: number | null } {
  if (!engineHasOrderBook(engine)) {
    return { avg: null, best: null, worst: null };
  }
  const spreads = output.snapshots
    .map((s) => s.spread?.toNumber())
    .filter((x): x is number => x !== undefined && Number.isFinite(x));
  if (spreads.length === 0) return { avg: null, best: null, worst: null };
  return {
    avg: mean(spreads),
    best: Math.min(...spreads),
    worst: Math.max(...spreads),
  };
}

function depthStats(
  output: SimulationOutput,
  engine: EngineKey
): { avg: number | null } {
  if (!engineHasOrderBook(engine)) return { avg: null };
  const depths = output.snapshots
    .map((s) => {
      const b = s.bidDepth?.toNumber();
      const a = s.askDepth?.toNumber();
      if (b === undefined && a === undefined) return null;
      return (b ?? 0) + (a ?? 0);
    })
    .filter((x): x is number => x !== null && Number.isFinite(x));
  if (depths.length === 0) return { avg: null };
  return { avg: mean(depths) };
}

function totalRequestedQty(output: SimulationOutput): number {
  return output.intents.reduce((sum, i) => {
    const q = i.qty ?? 0;
    return sum + (typeof q === "number" ? q : q.toNumber());
  }, 0);
}

function shockMetrics(
  output: SimulationOutput,
  engine: EngineKey
): {
  maxDislocation: number | null;
  recoveryTime: number | null;
  recovered: boolean | null;
  postShockAvgSpread: number | null;
  postShockFillRatio: number | null;
} {
  if (output.config.type !== "SHOCK") {
    return {
      maxDislocation: null,
      recoveryTime: null,
      recovered: null,
      postShockAvgSpread: null,
      postShockFillRatio: null,
    };
  }
  const shockTime = output.config.shockTime ?? SHOCK_TIME_MS;
  const snaps = output.snapshots;
  const pre = snaps.filter((s) => s.timestamp < shockTime);
  const post = snaps.filter((s) => s.timestamp >= shockTime);

  const preMids = pre
    .map((s) => s.midPrice?.toNumber())
    .filter((x): x is number => x !== undefined && Number.isFinite(x));
  const postMids = post
    .map((s) => s.midPrice?.toNumber())
    .filter((x): x is number => x !== undefined && Number.isFinite(x));

  const preBase = preMids.length > 0 ? mean(preMids) : 0.5;

  const maxDislocation =
    postMids.length === 0
      ? null
      : Math.max(...postMids.map((p) => Math.abs(p - preBase)));

  // Steady-state estimate: mean of last 10% of post-shock mids.
  // Require enough post-shock samples that the "steady state" isn't
  // essentially one point (otherwise the first window trivially matches
  // and recovery reads as 0.00 — an artifact, not a finding).
  let recoveryTime: number | null = null;
  let recovered: boolean | null = null;
  if (postMids.length >= RECOVERY_MIN_POST_MIDS) {
    const tailStart = Math.max(
      0,
      postMids.length - Math.max(RECOVERY_WINDOW, Math.floor(postMids.length * 0.1))
    );
    const steady = mean(postMids.slice(tailStart));
    let found = -1;
    for (let i = 0; i <= postMids.length - RECOVERY_WINDOW; i++) {
      let ok = true;
      for (let k = 0; k < RECOVERY_WINDOW; k++) {
        if (Math.abs(postMids[i + k] - steady) > RECOVERY_TOLERANCE) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = i;
        break;
      }
    }
    recovered = found >= 0;
    recoveryTime = found >= 0 ? found : null;
  }

  // Post-shock spread only for order-book engines
  let postShockAvgSpread: number | null = null;
  if (engineHasOrderBook(engine)) {
    const ps = post
      .map((s) => s.spread?.toNumber())
      .filter((x): x is number => x !== undefined && Number.isFinite(x));
    postShockAvgSpread = ps.length > 0 ? mean(ps) : null;
  }

  // Post-shock fill ratio (volume-based, restricted to post-shock intents)
  let postShockFillRatio: number | null = null;
  let reqQty = 0;
  let filled = 0;
  for (let i = 0; i < output.intents.length; i++) {
    const intent = output.intents[i];
    if (intent.timestamp < shockTime) continue;
    const q = intent.qty ?? 0;
    reqQty += typeof q === "number" ? q : q.toNumber();
    const r = output.results[i];
    filled += r.filledQty.toNumber();
  }
  if (reqQty > 0) postShockFillRatio = filled / reqQty;

  return {
    maxDislocation,
    recoveryTime,
    recovered,
    postShockAvgSpread,
    postShockFillRatio,
  };
}

type RoutingLogData = {
  intentId?: string;
  engine?: "CLOB" | "LMSR";
};

function isRoutingLogData(x: unknown): x is RoutingLogData {
  if (!x || typeof x !== "object") return false;
  const d = x as RoutingLogData;
  return typeof d.intentId === "string" && (d.engine === "CLOB" || d.engine === "LMSR");
}

function hybridRoutingMetrics(output: SimulationOutput): {
  clobFirstShare: number | null;
  lmsrFirstShare: number | null;
  fallbackRate: number | null;
} {
  // Walk ROUTING_DECISION logs grouped by intent, preserving order of first occurrence.
  const firstByIntent = new Map<string, "CLOB" | "LMSR">();
  const enginesByIntent = new Map<string, Set<"CLOB" | "LMSR">>();
  for (const log of output.logs as LogEntry[]) {
    if (log.type !== "ROUTING_DECISION") continue;
    if (!isRoutingLogData(log.data)) continue;
    const id = log.data.intentId as string;
    const engine = log.data.engine as "CLOB" | "LMSR";
    if (!firstByIntent.has(id)) firstByIntent.set(id, engine);
    let set = enginesByIntent.get(id);
    if (!set) {
      set = new Set();
      enginesByIntent.set(id, set);
    }
    set.add(engine);
  }
  const total = firstByIntent.size;
  if (total === 0) {
    return { clobFirstShare: null, lmsrFirstShare: null, fallbackRate: null };
  }
  let clobFirst = 0;
  let lmsrFirst = 0;
  let fallback = 0;
  for (const [id, first] of firstByIntent.entries()) {
    if (first === "CLOB") clobFirst++;
    else lmsrFirst++;
    const set = enginesByIntent.get(id)!;
    // Fallback = CLOB was attempted first AND LMSR was also used for the same intent
    if (first === "CLOB" && set.has("LMSR")) fallback++;
  }
  return {
    clobFirstShare: clobFirst / total,
    lmsrFirstShare: lmsrFirst / total,
    fallbackRate: fallback / total,
  };
}

// ---- Aggregation across seeds ----------------------------------------------

/**
 * Effective matched-intent volume for the volumeFillRatio denominator match.
 *
 * The runner's `totalVolume` only counts taker-side `filledQty`. In a CLOB trade
 * both a resting maker intent and the incoming taker intent are executed for the
 * same quantity, so taker-only volume under-reports by ~2× on a book that clears.
 * LMSR fills have no maker intent (the AMM is the counterparty), so they stay 1×.
 * Hybrid fills are labelled with `counterparty: "CLOB" | "LMSR"` by the router,
 * so we can mix the two rules per fill.
 */
function effectiveMatchedQty(output: SimulationOutput, engine: EngineKey): number {
  if (engine === "LMSR") {
    return output.metrics.totalVolume.toNumber();
  }
  if (engine === "CLOB") {
    return output.metrics.totalVolume.toNumber() * 2;
  }
  // HYBRID: walk fills, double CLOB legs (both sides are intents), single LMSR legs.
  let matched = 0;
  for (const r of output.results) {
    for (const f of r.fills) {
      const q = f.qty.toNumber();
      if (f.counterparty === "CLOB") matched += q * 2;
      else matched += q;
    }
  }
  return matched;
}

function computeCellMetrics(cellRuns: RunRecord[]): MetricsRow {
  const first = cellRuns[0];
  const perRun = cellRuns.map((r) => {
    const m = r.output.metrics;
    const requested = totalRequestedQty(r.output);
    const matched = effectiveMatchedQty(r.output, r.engine);
    const volFill = requested > 0 ? matched / requested : 0;
    // Null out metrics that were computed over 0 valid samples so downstream
    // code doesn't confuse "structural N/A" with a genuine zero.
    const slipCount = r.output.results.filter((x) => x.slippage !== null).length;
    const impactCount = r.output.results.filter((x) => x.priceImpact !== null).length;
    return {
      volFill,
      avgAbsSlippage: slipCount > 0 ? m.avgSlippage.toNumber() : null,
      avgAbsPriceImpact: impactCount > 0 ? m.avgPriceImpact.toNumber() : null,
      executedVolume: m.totalVolume.toNumber(),
      priceStability: priceStability(r.output),
      fillRatio: m.fillRatio.toNumber(),
      totalValue: m.totalValue.toNumber(),
      finalMidPrice: m.finalMidPrice?.toNumber() ?? null,
      priceMovement: m.priceMovement?.toNumber() ?? null,
      spread: spreadStats(r.output, r.engine),
      depth: depthStats(r.output, r.engine),
      shock: shockMetrics(r.output, r.engine),
      routing:
        r.engine === "HYBRID"
          ? hybridRoutingMetrics(r.output)
          : { clobFirstShare: null, lmsrFirstShare: null, fallbackRate: null },
    };
  });

  return {
    scenario: first.scenario,
    engine: first.engine,
    seedCount: cellRuns.length,

    volumeFillRatio: mean(perRun.map((p) => p.volFill)),
    avgAbsSlippage: meanOrNull(perRun.map((p) => p.avgAbsSlippage)),
    avgAbsPriceImpact: meanOrNull(perRun.map((p) => p.avgAbsPriceImpact)),
    executedVolume: mean(perRun.map((p) => p.executedVolume)),
    priceStability: meanOrNull(perRun.map((p) => p.priceStability)),

    avgSpread: meanOrNull(perRun.map((p) => p.spread.avg)),
    avgDepth: meanOrNull(perRun.map((p) => p.depth.avg)),
    bestSpread: meanOrNull(perRun.map((p) => p.spread.best)),
    worstSpread: meanOrNull(perRun.map((p) => p.spread.worst)),

    maxDislocation: meanOrNull(perRun.map((p) => p.shock.maxDislocation)),
    recoveryTime: meanOrNull(perRun.map((p) => p.shock.recoveryTime)),
    recovered:
      first.scenario === "SHOCK"
        ? perRun.every((p) => p.shock.recovered === true)
        : null,
    postShockAvgSpread: meanOrNull(perRun.map((p) => p.shock.postShockAvgSpread)),
    postShockFillRatio: meanOrNull(perRun.map((p) => p.shock.postShockFillRatio)),

    clobFirstShare: meanOrNull(perRun.map((p) => p.routing.clobFirstShare)),
    lmsrFirstShare: meanOrNull(perRun.map((p) => p.routing.lmsrFirstShare)),
    fallbackRate: meanOrNull(perRun.map((p) => p.routing.fallbackRate)),

    completionGainVsClob: null,
    slippagePenaltyVsClob: null,
    slippagePenaltyVsLmsr: null,

    fillRatio: mean(perRun.map((p) => p.fillRatio)),
    totalValue: mean(perRun.map((p) => p.totalValue)),
    finalMidPrice: meanOrNull(perRun.map((p) => p.finalMidPrice)),
    priceMovement: meanOrNull(perRun.map((p) => p.priceMovement)),
  };
}

function aggregateMetrics(runs: RunRecord[]): MetricsRow[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.scenario}|${r.engine}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(r);
  }
  const rows: MetricsRow[] = [];
  for (const g of groups.values()) rows.push(computeCellMetrics(g));

  // Second pass: fill hybrid-vs-baseline derived metrics per scenario
  for (const scenario of SCENARIOS) {
    const clob = rows.find((r) => r.scenario === scenario && r.engine === "CLOB");
    const lmsr = rows.find((r) => r.scenario === scenario && r.engine === "LMSR");
    const hybrid = rows.find((r) => r.scenario === scenario && r.engine === "HYBRID");
    if (!hybrid) continue;
    if (clob) {
      hybrid.completionGainVsClob = hybrid.volumeFillRatio - clob.volumeFillRatio;
      if (hybrid.avgAbsSlippage !== null && clob.avgAbsSlippage !== null) {
        hybrid.slippagePenaltyVsClob = hybrid.avgAbsSlippage - clob.avgAbsSlippage;
      }
    }
    if (lmsr) {
      if (hybrid.avgAbsSlippage !== null && lmsr.avgAbsSlippage !== null) {
        hybrid.slippagePenaltyVsLmsr = hybrid.avgAbsSlippage - lmsr.avgAbsSlippage;
      }
    }
  }

  const sOrder = new Map(SCENARIOS.map((s, i) => [s, i]));
  const eOrder = new Map(ENGINES.map((e, i) => [e, i]));
  rows.sort((a, b) => {
    const s = (sOrder.get(a.scenario) ?? 0) - (sOrder.get(b.scenario) ?? 0);
    if (s !== 0) return s;
    return (eOrder.get(a.engine) ?? 0) - (eOrder.get(b.engine) ?? 0);
  });
  return rows;
}

// ---- Chart series -----------------------------------------------------------

function buildMergedChartSeries(
  runs: RunRecord[],
  scenario: ScenarioType,
  engines: EngineKey[]
): MergedChartPoint[] {
  const perEngine: Record<string, TimeSeriesPoint[]> = {};
  for (const engine of engines) {
    const candidate = runs
      .filter((r) => r.scenario === scenario && r.engine === engine)
      .sort((a, b) => a.seed - b.seed)[0];
    perEngine[engine] = candidate ? extractTimeSeries(candidate.output) : [];
  }
  const maxLen = Math.max(0, ...engines.map((e) => perEngine[e].length));
  const merged: MergedChartPoint[] = [];
  for (let i = 0; i < maxLen; i++) {
    const point: MergedChartPoint = { idx: i, timestamp: 0 };
    let stampSet = false;
    for (const engine of engines) {
      const p = perEngine[engine][i];
      if (!stampSet && p) {
        point.timestamp = p.timestamp;
        stampSet = true;
      }
      point[`${engine}_mid`] = p?.midPrice ?? null;
      point[`${engine}_spread`] = p?.spread ?? null;
      const totalDepth =
        p && (p.bidDepth !== null || p.askDepth !== null)
          ? (p.bidDepth ?? 0) + (p.askDepth ?? 0)
          : null;
      point[`${engine}_depth`] = totalDepth;
    }
    merged.push(point);
  }
  return merged;
}

type AggregateMetricKey =
  | "volumeFillRatio"
  | "avgAbsSlippage"
  | "avgAbsPriceImpact"
  | "avgSpread"
  | "avgDepth"
  | "priceStability";

function buildAggregateBarData(
  metrics: MetricsRow[],
  key: AggregateMetricKey
): Array<{ scenario: string } & Record<EngineKey, number | null>> {
  return SCENARIOS.map((scenario) => {
    const row: { scenario: string } & Record<EngineKey, number | null> = {
      scenario,
      CLOB: null,
      LMSR: null,
      HYBRID: null,
    };
    for (const engine of ENGINES) {
      const r = metrics.find((m) => m.scenario === scenario && m.engine === engine);
      if (!r) continue;
      const v = r[key];
      row[engine] = typeof v === "number" ? v : null;
    }
    return row;
  });
}

function buildHybridRoutingStacks(
  metrics: MetricsRow[]
): Array<{ scenario: string; clobFirst: number; lmsrFirst: number; fallback: number }> {
  return SCENARIOS.map((scenario) => {
    const h = metrics.find((m) => m.scenario === scenario && m.engine === "HYBRID");
    return {
      scenario,
      clobFirst: h?.clobFirstShare ?? 0,
      lmsrFirst: h?.lmsrFirstShare ?? 0,
      fallback: h?.fallbackRate ?? 0,
    };
  });
}

// ---- Winners ----------------------------------------------------------------

interface ScenarioWinners {
  completeness: EngineKey | null;
  tradingCost: EngineKey | null;
  overallBalance: EngineKey | null;
}

function pickWinners(scenario: ScenarioType, rows: MetricsRow[]): ScenarioWinners {
  const cells = rows.filter((r) => r.scenario === scenario);
  if (cells.length === 0) {
    return { completeness: null, tradingCost: null, overallBalance: null };
  }
  // Best completeness = highest volume fill ratio
  const completeness = cells.reduce((best, c) =>
    c.volumeFillRatio > best.volumeFillRatio ? c : best
  ).engine;

  // Best trading cost = lowest avgAbsSlippage among engines with real slippage samples.
  // Filter out cells whose slippage was computed over 0 valid samples (null), since
  // those would otherwise falsely "win" at 0.000.
  const withSlip = cells.filter(
    (c): c is MetricsRow & { avgAbsSlippage: number } =>
      c.executedVolume > 0 && c.avgAbsSlippage !== null
  );
  const tradingCost =
    withSlip.length === 0
      ? null
      : withSlip.reduce((best, c) =>
          c.avgAbsSlippage < best.avgAbsSlippage ? c : best
        ).engine;

  // Best overall balance: maximise (volFill - normalized slippage) among cells with
  // real slippage. If no cell has measurable slippage, fall back to best completeness.
  const scored = cells.filter(
    (c): c is MetricsRow & { avgAbsSlippage: number } => c.avgAbsSlippage !== null
  );
  let overallBalance: EngineKey;
  if (scored.length === 0) {
    overallBalance = completeness;
  } else {
    const maxSlip = Math.max(...scored.map((c) => c.avgAbsSlippage)) || 1e-9;
    overallBalance = scored.reduce((best, c) => {
      const score = c.volumeFillRatio - c.avgAbsSlippage / maxSlip;
      const bestScore = best.volumeFillRatio - best.avgAbsSlippage / maxSlip;
      return score > bestScore ? c : best;
    }).engine;
  }

  return { completeness, tradingCost, overallBalance };
}

// ---- Export -----------------------------------------------------------------

function exportComparisonJSON(output: ComparisonOutput): string {
  return JSON.stringify(
    output,
    (_k, v) => {
      if (v instanceof Decimal) return v.toString();
      if (v instanceof Map) return Object.fromEntries(v.entries());
      return v;
    },
    2
  );
}

function exportComparisonCSV(output: ComparisonOutput): string {
  const lines: string[] = [];
  lines.push(
    [
      "scenario",
      "engine",
      "seedCount",
      "volumeFillRatio",
      "avgAbsSlippage",
      "avgAbsPriceImpact",
      "executedVolume",
      "priceStability",
      "avgSpread",
      "avgDepth",
      "bestSpread",
      "worstSpread",
      "maxDislocation",
      "recoveryTime",
      "recovered",
      "postShockAvgSpread",
      "postShockFillRatio",
      "clobFirstShare",
      "lmsrFirstShare",
      "fallbackRate",
      "completionGainVsClob",
      "slippagePenaltyVsClob",
      "slippagePenaltyVsLmsr",
      "fillRatio",
      "totalValue",
      "finalMidPrice",
      "priceMovement",
    ].join(",")
  );
  const cell = (v: number | boolean | null) =>
    v === null ? "" : typeof v === "boolean" ? (v ? "true" : "false") : v;
  for (const r of output.metrics) {
    lines.push(
      [
        r.scenario,
        r.engine,
        r.seedCount,
        cell(r.volumeFillRatio),
        cell(r.avgAbsSlippage),
        cell(r.avgAbsPriceImpact),
        cell(r.executedVolume),
        cell(r.priceStability),
        cell(r.avgSpread),
        cell(r.avgDepth),
        cell(r.bestSpread),
        cell(r.worstSpread),
        cell(r.maxDislocation),
        cell(r.recoveryTime),
        cell(r.recovered),
        cell(r.postShockAvgSpread),
        cell(r.postShockFillRatio),
        cell(r.clobFirstShare),
        cell(r.lmsrFirstShare),
        cell(r.fallbackRate),
        cell(r.completionGainVsClob),
        cell(r.slippagePenaltyVsClob),
        cell(r.slippagePenaltyVsLmsr),
        cell(r.fillRatio),
        cell(r.totalValue),
        cell(r.finalMidPrice),
        cell(r.priceMovement),
      ].join(",")
    );
  }
  return lines.join("\n");
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function scenarioLabel(s: ScenarioType): string {
  switch (s) {
    case "THIN_LIQUIDITY":
      return "Thin Liquidity";
    case "THICK_LIQUIDITY":
      return "Thick Liquidity";
    case "SHOCK":
      return "Shock";
    case "CUSTOM":
      return "Custom";
  }
}

function fmtNum(v: number | null, digits = 4, pct = false): string {
  if (v === null || !Number.isFinite(v)) return "N/A";
  return pct ? `${(v * 100).toFixed(digits)}%` : v.toFixed(digits);
}

// ============================================================================
// Main Component
// ============================================================================

export default function ExperimentsPage() {
  // Scenario (non-engine) parameters shared across the sweep
  const [numTraders, setNumTraders] = useState(20);
  const [initialCash, setInitialCash] = useState(10000);
  const [numOrders, setNumOrders] = useState(200);
  const [timeWindow, setTimeWindow] = useState(10000);
  const [baseArrivalRate, setBaseArrivalRate] = useState(10);
  const [orderSizeMin, setOrderSizeMin] = useState(1);
  const [orderSizeMax, setOrderSizeMax] = useState(20);
  const [priceSpread, setPriceSpread] = useState(0.1);

  // Engine parameters shared across the sweep
  const [tickSize, setTickSize] = useState(0.01);
  const [bParam, setBParam] = useState(100);
  const [spreadThreshold, setSpreadThreshold] = useState(0.05);
  const [depthThreshold, setDepthThreshold] = useState(10);
  const [depthTicks, setDepthTicks] = useState(3);

  // Sweep sizing
  const [seedCount, setSeedCount] = useState(5);
  const [baseSeed, setBaseSeed] = useState(42);

  // Comparison output + progress
  const [comparisonOutput, setComparisonOutput] =
    useState<ComparisonOutput | null>(null);
  const [comparisonRunning, setComparisonRunning] = useState(false);
  const [comparisonProgress, setComparisonProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const runComparison = useCallback(async () => {
    setComparisonRunning(true);
    setComparisonOutput(null);
    setComparisonProgress({ done: 0, total: 0 });

    const base: BaseScenarioParams = {
      numTraders,
      initialCash,
      numOrders,
      timeWindow,
      baseArrivalRate,
      orderSizeMin,
      orderSizeMax,
      priceSpread,
    };
    const engineParams: EngineParams = {
      tickSize,
      bParam,
      spreadThreshold,
      depthThreshold,
      depthTicks,
    };
    const seeds = Array.from({ length: seedCount }, (_, i) => baseSeed + i);
    const tasks = buildSweep(SCENARIOS, ENGINES, seeds);

    setComparisonProgress({ done: 0, total: tasks.length });
    await yieldToBrowser();

    const runs: RunRecord[] = [];
    try {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const config = buildScenarioConfigFor(task.scenario, task.seed, base);
        const engine = createEngineFor(task.engine, engineParams);
        const runner = new SimulationRunner(engine);
        const simOutput = runner.runSync(config);
        runs.push({
          scenario: task.scenario,
          engine: task.engine,
          seed: task.seed,
          output: simOutput,
        });
        setComparisonProgress({ done: i + 1, total: tasks.length });
        await yieldToBrowser();
      }

      const metrics = aggregateMetrics(runs);
      const chartSeries: Record<ScenarioType, MergedChartPoint[]> = {
        THIN_LIQUIDITY: buildMergedChartSeries(runs, "THIN_LIQUIDITY", ENGINES),
        THICK_LIQUIDITY: buildMergedChartSeries(runs, "THICK_LIQUIDITY", ENGINES),
        SHOCK: buildMergedChartSeries(runs, "SHOCK", ENGINES),
        CUSTOM: [],
      };

      const result: ComparisonOutput = {
        baseScenario: base,
        engineParams,
        scenarios: [...SCENARIOS],
        engines: [...ENGINES],
        seeds,
        runs,
        metrics,
        chartSeries,
        createdAt: Date.now(),
      };

      startTransition(() => {
        setComparisonOutput(result);
      });
    } catch (error) {
      console.error("Comparison error:", error);
    } finally {
      setComparisonRunning(false);
    }
  }, [
    numTraders,
    initialCash,
    numOrders,
    timeWindow,
    baseArrivalRate,
    orderSizeMin,
    orderSizeMax,
    priceSpread,
    tickSize,
    bParam,
    spreadThreshold,
    depthThreshold,
    depthTicks,
    seedCount,
    baseSeed,
  ]);

  const exportComparisonJSONFile = () => {
    if (!comparisonOutput) return;
    downloadBlob(
      exportComparisonJSON(comparisonOutput),
      `comparison-summary-${comparisonOutput.createdAt}.json`,
      "application/json"
    );
  };

  const exportComparisonCSVFile = () => {
    if (!comparisonOutput) return;
    downloadBlob(
      exportComparisonCSV(comparisonOutput),
      `comparison-summary-${comparisonOutput.createdAt}.csv`,
      "text/csv"
    );
  };

  const aggregateCharts = useMemo(() => {
    if (!comparisonOutput) return null;
    return {
      volumeFillRatio: buildAggregateBarData(
        comparisonOutput.metrics,
        "volumeFillRatio"
      ),
      avgAbsSlippage: buildAggregateBarData(
        comparisonOutput.metrics,
        "avgAbsSlippage"
      ),
      avgAbsPriceImpact: buildAggregateBarData(
        comparisonOutput.metrics,
        "avgAbsPriceImpact"
      ),
      priceStability: buildAggregateBarData(
        comparisonOutput.metrics,
        "priceStability"
      ),
      avgSpread: buildAggregateBarData(comparisonOutput.metrics, "avgSpread"),
      avgDepth: buildAggregateBarData(comparisonOutput.metrics, "avgDepth"),
      hybridRouting: buildHybridRoutingStacks(comparisonOutput.metrics),
    };
  }, [comparisonOutput]);

  const winners = useMemo(() => {
    if (!comparisonOutput) return null;
    const map: Record<ScenarioType, ScenarioWinners> = {
      THIN_LIQUIDITY: pickWinners("THIN_LIQUIDITY", comparisonOutput.metrics),
      THICK_LIQUIDITY: pickWinners("THICK_LIQUIDITY", comparisonOutput.metrics),
      SHOCK: pickWinners("SHOCK", comparisonOutput.metrics),
      CUSTOM: { completeness: null, tradingCost: null, overallBalance: null },
    };
    return map;
  }, [comparisonOutput]);

  const comparisonBusy = comparisonRunning || isPending;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Prediction Market Experiment Runner
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Sweeps all three engines across all three scenarios over multiple
            seeds. One click runs the full 3 × 3 comparison matrix.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Scenario Config */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
              Scenario Configuration
            </h2>

            <div className="space-y-4">
              <div className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded-md p-3">
                Runs all three scenarios (<span className="font-mono">THIN</span>,{" "}
                <span className="font-mono">THICK</span>,{" "}
                <span className="font-mono">SHOCK</span>). Non-engine parameters
                below are shared so the comparison stays fair.
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Base Seed
                  </label>
                  <input
                    type="number"
                    value={baseSeed}
                    onChange={(e) => setBaseSeed(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Traders
                  </label>
                  <input
                    type="number"
                    value={numTraders}
                    onChange={(e) => setNumTraders(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Orders
                  </label>
                  <input
                    type="number"
                    value={numOrders}
                    onChange={(e) => setNumOrders(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Initial Cash
                  </label>
                  <input
                    type="number"
                    value={initialCash}
                    onChange={(e) => setInitialCash(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Arrival Rate
                  </label>
                  <input
                    type="number"
                    value={baseArrivalRate}
                    onChange={(e) => setBaseArrivalRate(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Time Window (ms)
                  </label>
                  <input
                    type="number"
                    value={timeWindow}
                    onChange={(e) => setTimeWindow(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Price Spread
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={priceSpread}
                  onChange={(e) => setPriceSpread(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Order Size Range
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={orderSizeMin}
                    onChange={(e) => setOrderSizeMin(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    placeholder="Min"
                  />
                  <input
                    type="number"
                    value={orderSizeMax}
                    onChange={(e) => setOrderSizeMax(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    placeholder="Max"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Seeds per (scenario, engine)
                </label>
                <input
                  type="number"
                  min={1}
                  value={seedCount}
                  onChange={(e) => setSeedCount(Math.max(1, Number(e.target.value)))}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Total runs: {SCENARIOS.length * ENGINES.length * seedCount}
                </p>
              </div>
            </div>
          </div>

          {/* Engine Config */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
              Engine Configuration
            </h2>

            <div className="space-y-4">
              <div className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded-md p-3">
                All three engines run. Parameters below are shared across the
                sweep.
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    LMSR b
                  </label>
                  <input
                    type="number"
                    value={bParam}
                    onChange={(e) => setBParam(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    CLOB Tick Size
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    value={tickSize}
                    onChange={(e) => setTickSize(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Hybrid Router Parameters
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Spread Threshold
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={spreadThreshold}
                      onChange={(e) => setSpreadThreshold(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Depth Threshold
                    </label>
                    <input
                      type="number"
                      value={depthThreshold}
                      onChange={(e) => setDepthThreshold(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Depth Ticks
                  </label>
                  <input
                    type="number"
                    value={depthTicks}
                    onChange={(e) => setDepthTicks(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Run Button */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
              Run Full Comparison
            </h2>

            <button
              onClick={runComparison}
              disabled={comparisonBusy}
              className="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium mb-4"
            >
              {comparisonBusy
                ? `Running${
                    comparisonProgress
                      ? ` ${comparisonProgress.done}/${comparisonProgress.total}`
                      : "..."
                  }`
                : "Run Full Comparison"}
            </button>

            {comparisonBusy && comparisonProgress && (
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded h-2 mb-4 overflow-hidden">
                <div
                  className="h-2 bg-blue-600 transition-all"
                  style={{
                    width: `${
                      (comparisonProgress.done /
                        Math.max(1, comparisonProgress.total)) *
                      100
                    }%`,
                  }}
                />
              </div>
            )}

            {comparisonOutput && !comparisonBusy && (
              <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                <div>
                  Last run:{" "}
                  {new Date(comparisonOutput.createdAt).toLocaleTimeString()}
                </div>
                <div>
                  {comparisonOutput.runs.length} simulations across{" "}
                  {comparisonOutput.scenarios.length} scenarios &times;{" "}
                  {comparisonOutput.engines.length} engines.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Comparison Dashboard */}
        {comparisonOutput && aggregateCharts && winners && (
          <ComparisonDashboard
            output={comparisonOutput}
            aggregateCharts={aggregateCharts}
            winners={winners}
            onExportJSON={exportComparisonJSONFile}
            onExportCSV={exportComparisonCSVFile}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Comparison Dashboard
// ============================================================================

type AggregateCharts = {
  volumeFillRatio: Array<{ scenario: string } & Record<EngineKey, number | null>>;
  avgAbsSlippage: Array<{ scenario: string } & Record<EngineKey, number | null>>;
  avgAbsPriceImpact: Array<{ scenario: string } & Record<EngineKey, number | null>>;
  priceStability: Array<{ scenario: string } & Record<EngineKey, number | null>>;
  avgSpread: Array<{ scenario: string } & Record<EngineKey, number | null>>;
  avgDepth: Array<{ scenario: string } & Record<EngineKey, number | null>>;
  hybridRouting: Array<{
    scenario: string;
    clobFirst: number;
    lmsrFirst: number;
    fallback: number;
  }>;
};

function ComparisonDashboard({
  output,
  aggregateCharts,
  winners,
  onExportJSON,
  onExportCSV,
}: {
  output: ComparisonOutput;
  aggregateCharts: AggregateCharts;
  winners: Record<ScenarioType, ScenarioWinners>;
  onExportJSON: () => void;
  onExportCSV: () => void;
}) {
  return (
    <div className="space-y-6">
      <SummaryCards output={output} />
      <WinnerCards scenarios={output.scenarios} winners={winners} />
      <HeadlineTable metrics={output.metrics} />
      {output.scenarios.map((scenario) => (
        <ScenarioSection key={scenario} scenario={scenario} output={output} />
      ))}
      <AggregateBarsPanel charts={aggregateCharts} />
      <HybridRoutingPanel data={aggregateCharts.hybridRouting} />

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
          Export
        </h2>
        <div className="flex gap-4 flex-wrap">
          <button
            onClick={onExportJSON}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium"
          >
            Export comparison-summary.json
          </button>
          <button
            onClick={onExportCSV}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
          >
            Export comparison-summary.csv
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCards({ output }: { output: ComparisonOutput }) {
  const cards: Array<{ label: string; value: string }> = [
    { label: "Total Runs", value: `${output.runs.length}` },
    { label: "Scenarios", value: `${output.scenarios.length}` },
    { label: "Engines", value: output.engines.join(", ") },
    { label: "Seeds", value: `${output.seeds.length}` },
    { label: "Orders / run", value: `${output.baseScenario.numOrders}` },
    {
      label: "Generated",
      value: new Date(output.createdAt).toLocaleTimeString(),
    },
  ];
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
        Comparison Summary
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-gray-100 dark:bg-gray-700 p-3 rounded">
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {c.label}
            </div>
            <div className="text-sm font-semibold text-gray-900 dark:text-white">
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WinnerCards({
  scenarios,
  winners,
}: {
  scenarios: ScenarioType[];
  winners: Record<ScenarioType, ScenarioWinners>;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
        Per-Scenario Winners
      </h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Computed from metrics — not hand-written. Completeness = highest volume
        fill ratio. Trading cost = lowest avg |slippage|. Overall balance = vol
        fill minus scenario-normalised slippage.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {scenarios.map((s) => {
          const w = winners[s];
          return (
            <div
              key={s}
              className="bg-gray-50 dark:bg-gray-900 rounded p-4 border border-gray-200 dark:border-gray-700"
            >
              <div className="text-sm font-semibold text-gray-800 dark:text-white mb-2">
                {scenarioLabel(s)}
              </div>
              <WinnerRow label="Execution completeness" engine={w.completeness} />
              <WinnerRow label="Lowest trading cost" engine={w.tradingCost} />
              <WinnerRow label="Best overall balance" engine={w.overallBalance} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WinnerRow({
  label,
  engine,
}: {
  label: string;
  engine: EngineKey | null;
}) {
  return (
    <div className="flex justify-between items-center py-1 text-sm">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      <span className="font-medium text-gray-900 dark:text-white flex items-center gap-2">
        {engine ? (
          <>
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: ENGINE_COLORS[engine] }}
            />
            {engine}
          </>
        ) : (
          "—"
        )}
      </span>
    </div>
  );
}

// Rows × Columns = (metric rows) × (scenarios × engines)
function HeadlineTable({ metrics }: { metrics: MetricsRow[] }) {
  const rows: Array<{
    key: string;
    label: string;
    accessor: (m: MetricsRow) => number | null;
    format: "pct" | "num4" | "num6" | "num2";
    note?: string;
  }> = [
    {
      key: "volumeFillRatio",
      label: "Volume fill ratio",
      accessor: (m) => m.volumeFillRatio,
      format: "pct",
    },
    {
      key: "avgAbsSlippage",
      label: "Avg |slippage|",
      accessor: (m) => m.avgAbsSlippage,
      format: "num6",
    },
    {
      key: "avgAbsPriceImpact",
      label: "Avg |price impact|",
      accessor: (m) => m.avgAbsPriceImpact,
      format: "num6",
    },
    {
      key: "executedVolume",
      label: "Executed volume",
      accessor: (m) => m.executedVolume,
      format: "num2",
    },
    {
      key: "priceStability",
      label: "Price stability (σ mid)",
      accessor: (m) => m.priceStability,
      format: "num4",
    },
    {
      key: "avgSpread",
      label: "Avg spread",
      accessor: (m) => m.avgSpread,
      format: "num4",
      note: "Not structurally defined for LMSR",
    },
    {
      key: "avgDepth",
      label: "Avg visible depth",
      accessor: (m) => m.avgDepth,
      format: "num2",
      note: "Order-book-only liquidity measure",
    },
    {
      key: "maxDislocation",
      label: "Max shock dislocation",
      accessor: (m) => m.maxDislocation,
      format: "num4",
      note: "SHOCK only",
    },
    {
      key: "recoveryTime",
      label: "Recovery time (orders)",
      accessor: (m) => m.recoveryTime,
      format: "num2",
      note: "SHOCK only",
    },
  ];

  const fmt = (v: number | null, f: "pct" | "num4" | "num6" | "num2") => {
    if (v === null || !Number.isFinite(v)) return "N/A";
    if (f === "pct") return `${(v * 100).toFixed(2)}%`;
    if (f === "num4") return v.toFixed(4);
    if (f === "num6") return v.toFixed(6);
    return v.toFixed(2);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
        Headline Comparison Table
      </h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              <th rowSpan={2} className="text-left py-2 pr-4 align-bottom">
                Metric
              </th>
              {SCENARIOS.map((s) => (
                <th
                  key={s}
                  colSpan={ENGINES.length}
                  className="text-center py-2 px-2 border-l border-gray-200 dark:border-gray-700"
                >
                  {scenarioLabel(s)}
                </th>
              ))}
            </tr>
            <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
              {SCENARIOS.flatMap((s) =>
                ENGINES.map((e) => (
                  <th
                    key={`${s}-${e}`}
                    className="text-right py-1 pr-2 pl-2 border-l border-gray-100 dark:border-gray-700"
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                      style={{ backgroundColor: ENGINE_COLORS[e] }}
                    />
                    {e}
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody className="text-gray-800 dark:text-gray-200">
            {rows.map((row) => (
              <tr
                key={row.key}
                className="border-b border-gray-100 dark:border-gray-700"
              >
                <td
                  className="py-2 pr-4 font-medium"
                  title={row.note ?? undefined}
                >
                  {row.label}
                  {row.note && (
                    <span className="text-[10px] text-gray-400 ml-1">
                      ⓘ
                    </span>
                  )}
                </td>
                {SCENARIOS.flatMap((s) =>
                  ENGINES.map((e) => {
                    const cell = metrics.find(
                      (m) => m.scenario === s && m.engine === e
                    );
                    const v = cell ? row.accessor(cell) : null;
                    const naReason =
                      v === null
                        ? !engineHasOrderBook(e) &&
                          (row.key === "avgSpread" ||
                            row.key === "avgDepth")
                          ? "Not structurally defined for LMSR"
                          : row.key === "maxDislocation" ||
                            row.key === "recoveryTime"
                          ? "Only populated for SHOCK scenario"
                          : "Not available"
                        : undefined;
                    return (
                      <td
                        key={`${s}-${e}`}
                        className="py-2 px-2 text-right border-l border-gray-100 dark:border-gray-700 tabular-nums"
                        title={naReason}
                      >
                        {fmt(v, row.format)}
                      </td>
                    );
                  })
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScenarioSection({
  scenario,
  output,
}: {
  scenario: ScenarioType;
  output: ComparisonOutput;
}) {
  const series = output.chartSeries[scenario];
  const cells = output.metrics.filter((m) => m.scenario === scenario);
  const isShock = scenario === "SHOCK";
  const hybrid = cells.find((c) => c.engine === "HYBRID");

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-white">
          {scenarioLabel(scenario)}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          First-seed trajectory shown for charts; table values are means over{" "}
          {cells[0]?.seedCount ?? 0} seeds. Unified price series is quoted YES
          probability (CLOB mid / LMSR pYES / Hybrid quoted mid).
        </p>
      </div>

      <PerScenarioTable rows={cells} />

      {isShock && hybrid && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Post-shock fill ratio (Hybrid) ={" "}
          {fmtNum(hybrid.postShockFillRatio, 2, true)}; post-shock avg spread ={" "}
          {fmtNum(hybrid.postShockAvgSpread)}; recovered ={" "}
          {hybrid.recovered === null ? "N/A" : hybrid.recovered ? "yes" : "no"}.
        </div>
      )}

      <ChartPanel
        title={isShock ? "Quoted YES price (with shock marker)" : "Quoted YES price"}
        note={
          isShock
            ? `Vertical line at t=${SHOCK_TIME_MS}ms marks the scheduled shock.`
            : undefined
        }
      >
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => `${Math.round(Number(v))}`}
            />
            <YAxis domain={[0, 1]} />
            <Tooltip />
            <Legend />
            {isShock && (
              <ReferenceLine
                x={SHOCK_TIME_MS}
                stroke="#f97316"
                strokeDasharray="4 4"
                label={{ value: "shock", position: "top", fill: "#f97316" }}
              />
            )}
            {ENGINES.map((engine) => (
              <Line
                key={engine}
                type="monotone"
                dataKey={`${engine}_mid`}
                name={engine}
                stroke={ENGINE_COLORS[engine]}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel
        title="Spread over time (CLOB / Hybrid only)"
        note="LMSR has no order book — excluded rather than zero-filled."
      >
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => `${Math.round(Number(v))}`}
            />
            <YAxis />
            <Tooltip />
            <Legend />
            {ENGINES.filter(engineHasOrderBook).map((engine) => (
              <Line
                key={engine}
                type="monotone"
                dataKey={`${engine}_spread`}
                name={engine}
                stroke={ENGINE_COLORS[engine]}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel
        title="Order-book depth over time (CLOB / Hybrid only)"
        note="Totals are bid + ask at top-of-book; LMSR has no depth concept."
      >
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => `${Math.round(Number(v))}`}
            />
            <YAxis />
            <Tooltip />
            <Legend />
            {ENGINES.filter(engineHasOrderBook).map((engine) => (
              <Line
                key={engine}
                type="monotone"
                dataKey={`${engine}_depth`}
                name={engine}
                stroke={ENGINE_COLORS[engine]}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  );
}

function PerScenarioTable({ rows }: { rows: MetricsRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th className="py-2 pr-4">Engine</th>
            <th className="py-2 pr-4">Vol Fill</th>
            <th className="py-2 pr-4">|Slip|</th>
            <th className="py-2 pr-4">|Impact|</th>
            <th className="py-2 pr-4">Vol</th>
            <th className="py-2 pr-4">σ mid</th>
            <th className="py-2 pr-4">Avg Spread</th>
            <th className="py-2 pr-4">Avg Depth</th>
            <th className="py-2 pr-4">Hybrid Δvs CLOB</th>
            <th className="py-2 pr-4">Hybrid Δvs LMSR</th>
          </tr>
        </thead>
        <tbody className="text-gray-800 dark:text-gray-200">
          {rows.map((r) => (
            <tr
              key={`${r.scenario}-${r.engine}`}
              className="border-b border-gray-100 dark:border-gray-700"
            >
              <td className="py-2 pr-4 font-medium">
                <span
                  className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                  style={{ backgroundColor: ENGINE_COLORS[r.engine] }}
                />
                {r.engine}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                {fmtNum(r.volumeFillRatio, 2, true)}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                {fmtNum(r.avgAbsSlippage, 6)}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                {fmtNum(r.avgAbsPriceImpact, 6)}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                {fmtNum(r.executedVolume, 2)}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                {fmtNum(r.priceStability, 4)}
              </td>
              <td
                className="py-2 pr-4 tabular-nums"
                title={
                  r.avgSpread === null && !engineHasOrderBook(r.engine)
                    ? "Not structurally defined for LMSR"
                    : undefined
                }
              >
                {fmtNum(r.avgSpread, 4)}
              </td>
              <td
                className="py-2 pr-4 tabular-nums"
                title={
                  r.avgDepth === null && !engineHasOrderBook(r.engine)
                    ? "Order-book-only liquidity measure"
                    : undefined
                }
              >
                {fmtNum(r.avgDepth, 2)}
              </td>
              <td
                className="py-2 pr-4 tabular-nums"
                title={
                  r.engine === "HYBRID"
                    ? "vol fill minus CLOB vol fill; + favours hybrid"
                    : undefined
                }
              >
                {r.engine === "HYBRID"
                  ? fmtNum(r.completionGainVsClob, 2, true)
                  : "—"}
              </td>
              <td
                className="py-2 pr-4 tabular-nums"
                title={
                  r.engine === "HYBRID"
                    ? "avg |slip| minus LMSR avg |slip|; − favours hybrid"
                    : undefined
                }
              >
                {r.engine === "HYBRID"
                  ? fmtNum(r.slippagePenaltyVsLmsr, 6)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartPanel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-white">
          {title}
        </h3>
        {note && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {note}
          </span>
        )}
      </div>
      <div className="bg-gray-50 dark:bg-gray-900 rounded p-2">{children}</div>
    </div>
  );
}

function AggregateBarsPanel({ charts }: { charts: AggregateCharts }) {
  const panels: Array<{
    title: string;
    data: Array<{ scenario: string } & Record<EngineKey, number | null>>;
    note?: string;
  }> = [
    {
      title: "Volume fill ratio (higher = better)",
      data: charts.volumeFillRatio,
    },
    {
      title: "Avg absolute slippage (lower = better)",
      data: charts.avgAbsSlippage,
    },
    {
      title: "Avg absolute price impact (lower = better)",
      data: charts.avgAbsPriceImpact,
    },
    {
      title: "Price stability — σ of mid (lower = smoother)",
      data: charts.priceStability,
    },
    {
      title: "Avg spread (CLOB / Hybrid only)",
      data: charts.avgSpread,
      note: "LMSR omitted — not structurally defined",
    },
    {
      title: "Avg depth (CLOB / Hybrid only)",
      data: charts.avgDepth,
      note: "LMSR omitted — order-book-only",
    },
  ];
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">
        Aggregate Metrics
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {panels.map((panel) => (
          <ChartPanel key={panel.title} title={panel.title} note={panel.note}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={panel.data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="scenario" />
                <YAxis />
                <Tooltip />
                <Legend />
                {ENGINES.map((engine) => (
                  <Bar
                    key={engine}
                    dataKey={engine}
                    fill={ENGINE_COLORS[engine]}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        ))}
      </div>
    </div>
  );
}

function HybridRoutingPanel({
  data,
}: {
  data: Array<{
    scenario: string;
    clobFirst: number;
    lmsrFirst: number;
    fallback: number;
  }>;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-2 text-gray-800 dark:text-white">
        Hybrid Routing Split
      </h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        CLOB-first vs LMSR-first = venue initially attempted per intent. Fallback
        = share of intents that started on CLOB but needed LMSR to complete.
      </p>
      <ChartPanel title="Routing decisions by scenario (share of hybrid intents)">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="scenario" />
            <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
            <Tooltip formatter={(v) => `${(Number(v) * 100).toFixed(1)}%`} />
            <Legend />
            <Bar
              dataKey="clobFirst"
              name="CLOB-first"
              stackId="a"
              fill="#2563eb"
              isAnimationActive={false}
            />
            <Bar
              dataKey="lmsrFirst"
              name="LMSR-first"
              stackId="a"
              fill="#9333ea"
              isAnimationActive={false}
            />
            <Bar
              dataKey="fallback"
              name="Fallback (CLOB→LMSR)"
              fill="#f59e0b"
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  );
}
