/**
 * THE HEADLINE RESULT, AS A TEST.
 *
 * The dissertation's central quantitative claim is that routing marketable flow to
 * a CLOB and falling back to an LMSR cuts execution slippage by roughly 70% against
 * an order-book-only venue. That number was previously only reproducible by opening
 * /experiments in a browser and clicking run, which means it could drift from the
 * code silently and could not be checked by anyone reading the repository.
 *
 * This regenerates it from the same sweep the UI runs — 3 scenarios x 3 engines x 5
 * seeds, same defaults, same SimulationRunner — prints the table, and asserts the
 * reduction. If a change to the router erodes the result, this fails.
 *
 *   npm run experiment      # prints the table
 *   npm test                # runs it alongside everything else
 */
import { describe, it, expect } from "vitest";
import { runSweep, DEFAULTS, SCENARIOS, ENGINES } from "../src/lib/sweep";

describe("Experiment sweep: hybrid vs order-book-only slippage", () => {
  const result = runSweep(DEFAULTS);
  const cell = (s: string, e: string) =>
    result.cells.find((c) => c.scenario === s && c.engine === e) ?? null;

  it("prints the comparison table", () => {
    const fmt = (v: number | null) => (v === null ? "     n/a" : v.toFixed(6).padStart(8));
    const lines: string[] = [
      "",
      `seeds ${result.seeds.join(", ")} · ${DEFAULTS.numOrders} orders · ${DEFAULTS.numTraders} traders · b=${DEFAULTS.bParam}`,
      "",
      "mean absolute slippage".padEnd(19) + ENGINES.map((e) => e.padStart(8)).join("  "),
      "-".repeat(19 + ENGINES.length * 10),
    ];
    for (const s of SCENARIOS) {
      lines.push(s.padEnd(18) + " " + ENGINES.map((e) => fmt(cell(s, e)?.meanSlippage ?? null)).join("  "));
    }
    lines.push("");
    for (const s of SCENARIOS) {
      const clob = cell(s, "CLOB")?.meanSlippage ?? null;
      const hyb = cell(s, "HYBRID")?.meanSlippage ?? null;
      if (clob === null || hyb === null || clob === 0) { lines.push(`  ${s.padEnd(18)} n/a`); continue; }
      const pct = ((clob - hyb) / clob) * 100;
      lines.push(`  ${s.padEnd(18)} CLOB ${clob.toFixed(6)} -> HYBRID ${hyb.toFixed(6)}  (${pct >= 0 ? "-" : "+"}${Math.abs(pct).toFixed(1)}%)`);
    }
    console.log(lines.join("\n"));
    expect(result.cells.length).toBe(SCENARIOS.length * ENGINES.length);
  });

  it("every cell reports either a measured mean or an explicit n/a, never a false zero", () => {
    for (const c of result.cells) {
      if (c.meanSlippage === null) expect(c.samples).toBe(0);
      else expect(c.samples).toBeGreaterThan(0);
    }
  });

  it.each(["THIN_LIQUIDITY", "SHOCK"])(
    "hybrid cuts slippage against CLOB-only in %s",
    (scenario) => {
      const clob = cell(scenario, "CLOB")?.meanSlippage;
      const hyb = cell(scenario, "HYBRID")?.meanSlippage;
      expect(clob, `${scenario}: CLOB produced no measurable slippage`).not.toBeNull();
      expect(hyb, `${scenario}: HYBRID produced no measurable slippage`).not.toBeNull();
      const reduction = ((clob! - hyb!) / clob!) * 100;
      expect(reduction).toBeGreaterThan(50);
    },
  );
});
