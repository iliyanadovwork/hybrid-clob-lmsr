/**
 * The experiment sweep, as a library — so the headline result can be regenerated
 * from a terminal rather than only by loading /experiments in a browser.
 *
 * This runs the same 3 scenarios x 3 engines x N seeds grid the UI runs, with the
 * same defaults, through the same SimulationRunner. The UI and `npm run experiment`
 * therefore cannot drift: there is one implementation of the sweep and both call it.
 */
import {
  SimulationRunner,
  type ScenarioConfig,
  type ScenarioType,
  type SimulationOutput,
} from "./simulation";
import {
  createEngine,
  createHybridEngine,
  createHybridConfig,
} from "./engine-adapters";
import type { UnifiedEngine } from "./engine-common";

export type EngineKey = "CLOB" | "LMSR" | "HYBRID";

export const ENGINES: EngineKey[] = ["CLOB", "LMSR", "HYBRID"];
export const SCENARIOS: ScenarioType[] = ["THIN_LIQUIDITY", "THICK_LIQUIDITY", "SHOCK"];

const SHOCK_TIME_MS = 5000;

/** The defaults the /experiments page opens with. */
export const DEFAULTS = {
  numTraders: 20,
  initialCash: 10000,
  numOrders: 200,
  timeWindow: 10000,
  baseArrivalRate: 10,
  orderSizeMin: 1,
  orderSizeMax: 20,
  priceSpread: 0.1,
  tickSize: 0.01,
  bParam: 100,
  spreadThreshold: 0.05,
  depthThreshold: 10,
  depthTicks: 3,
  seedCount: 5,
  baseSeed: 42,
} as const;

export type SweepParams = typeof DEFAULTS;

export interface SweepTask {
  scenario: ScenarioType;
  engine: EngineKey;
  seed: number;
}

export interface RunRecord extends SweepTask {
  output: SimulationOutput;
}

export function buildSweep(
  scenarios: ScenarioType[],
  engines: EngineKey[],
  seeds: number[],
): SweepTask[] {
  const tasks: SweepTask[] = [];
  for (const scenario of scenarios) {
    for (const engine of engines) {
      for (const seed of seeds) tasks.push({ scenario, engine, seed });
    }
  }
  return tasks;
}

export function buildScenarioConfig(
  scenario: ScenarioType,
  seed: number,
  p: SweepParams,
): ScenarioConfig {
  const config: ScenarioConfig = {
    type: scenario,
    seed,
    numTraders: p.numTraders,
    initialCash: p.initialCash,
    numOrders: p.numOrders,
    timeWindow: p.timeWindow,
    baseArrivalRate: p.baseArrivalRate,
    orderSizeMin: p.orderSizeMin,
    orderSizeMax: p.orderSizeMax,
    priceSpread: p.priceSpread,
  };
  if (scenario === "SHOCK") {
    config.shockTime = SHOCK_TIME_MS;
    config.shockMagnitude = 0.15;
    config.shockProbability = 0.3;
  }
  return config;
}

export function createEngineFor(engine: EngineKey, p: SweepParams): UnifiedEngine {
  if (engine === "HYBRID") {
    return createHybridEngine(
      createHybridConfig({
        spreadThreshold: p.spreadThreshold,
        depthThreshold: p.depthThreshold,
        depthTicks: p.depthTicks,
        b: p.bParam,
        tickSize: p.tickSize,
      }),
    );
  }
  if (engine === "CLOB") {
    return createEngine("CLOB", { type: "CLOB", tickSize: p.tickSize });
  }
  return createEngine("LMSR", { type: "LMSR", liquidity: p.bParam });
}

/** Mean absolute slippage over the runs in one (scenario, engine) cell.
 *  Runs that produced no measurable trade contribute nothing and are counted
 *  separately, so "no valid samples" never reads as a perfect 0.000. */
export function meanSlippage(runs: RunRecord[]): { mean: number | null; samples: number } {
  const vals: number[] = [];
  for (const r of runs) {
    const measured = r.output.results.filter((x) => x.slippage !== null).length;
    if (measured > 0) vals.push(r.output.metrics.avgSlippage.toNumber());
  }
  if (vals.length === 0) return { mean: null, samples: 0 };
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, samples: vals.length };
}

export interface SweepResult {
  params: SweepParams;
  seeds: number[];
  cells: Array<{
    scenario: ScenarioType;
    engine: EngineKey;
    meanSlippage: number | null;
    samples: number;
  }>;
}

export function runSweep(params: SweepParams = DEFAULTS): SweepResult {
  const seeds = Array.from({ length: params.seedCount }, (_, i) => params.baseSeed + i);
  const runs: RunRecord[] = [];

  for (const task of buildSweep(SCENARIOS, ENGINES, seeds)) {
    const config = buildScenarioConfig(task.scenario, task.seed, params);
    const runner = new SimulationRunner(createEngineFor(task.engine, params));
    runs.push({ ...task, output: runner.runSync(config) });
  }

  const cells = SCENARIOS.flatMap((scenario) =>
    ENGINES.map((engine) => {
      const cellRuns = runs.filter((r) => r.scenario === scenario && r.engine === engine);
      const { mean, samples } = meanSlippage(cellRuns);
      return { scenario, engine, meanSlippage: mean, samples };
    }),
  );

  return { params, seeds, cells };
}
