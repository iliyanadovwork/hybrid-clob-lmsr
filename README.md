# A hybrid order book / market maker for prediction markets

BSc dissertation, King's College London. Awarded a First.

A prediction market has to quote a price for every outcome, continuously, including
when nobody is on the other side of the trade. A central limit order book does this
well when there is flow and badly when there is not: a thin book means a marketable
order walks the ladder and fills at a price nobody would have accepted. An automated
market maker always quotes, but charges for the privilege even when a counterparty
was available.

This implements both, plus a router that picks between them per order, and measures
what the combination actually buys you.

**What it measures:** a 3 scenario by 3 engine by 5 seed sweep of mean absolute
execution slippage, regenerated from the engines rather than read from a stored result.
Reproduce it with `npm run experiment`.

A scenario where a mechanism never produced a measurable trade reports **n/a**, not
zero, so it cannot win a comparison by default.

---

## The three engines

All three implement one `UnifiedEngine` interface (`src/lib/engine-common.ts`), so the
harness replays the identical generated order stream through each and compares like
with like.

**`src/lib/clob.ts`** a price-time priority matching engine. Best price first, then
arrival order. A limit sell is sized against holdings *minus* quantity already committed
to resting orders, so one balance cannot back two sells.

**`src/lib/binaryLmsr.ts`** a binary logarithmic market scoring rule. The cost function
is evaluated in a rearranged form that subtracts the largest exponent before
exponentiating, so a large position cannot overflow. Worst-case maker loss is bounded at
`b ln 2`. All arithmetic runs in 28-significant-digit decimals rather than floats.

**`src/lib/hybrid-router-v2.ts`** the router. One authoritative position per trader is
shared by both mechanisms, so shares bought through one can be sold through the other.
Orders on the opposite outcome are mapped onto the same book by flipping the side and
taking the complementary price, so a single matching path serves both sides instead of
two books that could drift apart.

## Verification

`npm test` → **344 tests in ~1.3s**, of four kinds, because each catches what the others
miss:

| Kind | What it does | Where |
|---|---|---|
| Worked examples | fixed sequences with hand-computed outcomes | `test/clob.test.ts`, `test/binaryLmsr.test.ts` |
| Property-based | 12 invariants over 100 generated sequences each, via fast-check the book never crosses, balances never go negative, equal prices fill in arrival order | `test/clob.property.test.ts` |
| Differential | a deliberately naive `ReferenceCLOB` that scans every order, required to agree fill-for-fill | `test/clob.differential.test.ts` |
| Golden master | pinned end states, so a change that keeps every invariant true but quietly alters behaviour still fails | `test/clob.golden.test.ts`, `test/binaryLmsr.regression.test.ts` |

The golden-master fixtures store their numbers as **strings**: a JSON number would
round-trip through a float and lose the precision the suite exists to pin.

`npm run experiment` regenerates the headline table and asserts the reduction, so the
central claim cannot drift from the code without a test going red.

## Running it

```bash
npm install
npm test # 344 tests
npm run experiment # regenerate the slippage table
npm run dev # interactive workbench
npx tsc --noEmit # clean
```

The workbench drives the real matching engine rather than a mock: submit orders, watch
both sides of the book and a running event log, reload preset book states.
`/experiments` runs the same sweep as `npm run experiment` with adjustable parameters.

## Layout

```
src/lib/clob.ts order book, price-time priority
src/lib/binaryLmsr.ts LMSR cost function and pricing
src/lib/hybrid-router-v2.ts the router and shared position ledger
src/lib/engine-common.ts the UnifiedEngine interface all three implement
src/lib/simulation.ts order-stream generator and scenario runner
src/lib/sweep.ts the experiment grid, shared by the CLI and the UI
src/app/ Next.js workbench and /experiments
test/ 344 tests
dissertation-claim-ledger.md every written claim, audited against the code
```

## The claim ledger

`dissertation-claim-ledger.md` walks the dissertation's written claims one at a time and
tags each **[OK]**, **[LIM]** or **[FLAG]** against the code meant to support it, with
file and line. It exists because a written claim and its implementation drift, and the
drift is invisible unless someone checks deliberately.

It is also self-correcting: entries marked **[SUPERSEDED]** describe claims that were
true when written and are not any more for instance the router originally had no LMSR
fallback for sell orders, which is no longer the case.

