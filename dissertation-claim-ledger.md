# Dissertation Claim Ledger — Chapters 4 & 5

Final verification pass against the code. Classification codes:

- **[OK]** directly implemented — sentence matches code
- **[LIM]** implemented with limitation — true but requires caveat
- **[NO]** not implemented — false as stated
- **[FRAME]** interpretive framing — opinion / motivation, no code-level claim
- **[FLAG]** overclaim, ambiguity, or missing caveat (applied in combination with above)

Evidence uses `file:start-end` ranges. Line numbers are from the current working copy of the code (see `git status` below). Short sentences that are pure prose bridges are not listed.

Working copy note: `src/app/experiments/page.tsx`, `src/lib/clob.ts`, `src/lib/engine-adapters.ts`, `src/lib/engine-common.ts`, `src/lib/hybrid-router-v2.ts`, `src/lib/metrics.ts`, `src/lib/simulation.ts`, and `tsconfig.json` have uncommitted modifications at the time of this audit.

---

## Chapter 4 — System Design

### 4.1 Overview

> "The system is designed as a deterministic and reproducible simulator that supports three market mechanisms..."
- **[LIM + FLAG]** Three mechanisms are implemented (`clob.ts`, `binaryLmsr.ts`, `hybrid-router-v2.ts`) and `/experiments` exposes exactly these three (`src/app/experiments/page.tsx:43`). Reproducibility is *behavioural* only — wall-clock `Date.now()` reads appear in fills, logs and snapshots (`hybrid-router-v2.ts:238`; `engine-adapters.ts:394`), so byte-level reproducibility is not guaranteed. Ch 5.8 acknowledges this; the Ch 4.1 summary does not, which is the canonical overclaim surface.
- **Safer wording:** "…deterministic in its simulated market behaviour and reproducible in its generated order stream under a fixed seed, with non-deterministic timestamp decoration in logs."

> "…a hybrid controller that routes incoming orders between the two mechanisms according to current liquidity conditions."
- **[OK]** True for BUY and, since the `!isSell` gate was removed, for SELL as well: the LMSR absorbs the remainder on both sides (`hybrid-router-v2.ts:350-351`, and `executeSell` at `:615`). LMSR sells use a native share-returning primitive rather than a buy of the opposite outcome, so the routing is symmetric and the sentence holds as written.
- **Was previously flagged [LIM]** on the grounds that no SELL fallback existed. That is no longer the case; the limitation and its suggested rewording are withdrawn.

### 4.2 High-Level Architecture

> "The platform is implemented as a single Next.js application in which the simulator executes on the client side."
- **[OK]** `src/app/experiments/page.tsx`, `src/app/clob-test/page.tsx`, `src/app/lmsr-test/page.tsx` all declare `"use client"`. No `route.ts` files exist anywhere in `src/`.

> "There is no separate backend service, HTTP API, or server-side route-handler layer in the simulator path."
- **[OK]** No `route.ts` / `route.tsx` under `src/` (grep confirms zero matches).

> "…while Route Handlers would provide request-handling endpoints if they were used; in this system, they are not part of the live simulation path."
- **[OK]** See above.

> "The simulation core in src/lib/ contains the mechanism implementations and the orchestration code required to run experiments."
- **[OK]** `src/lib/clob.ts`, `src/lib/binaryLmsr.ts`, `src/lib/hybrid-router-v2.ts`, `src/lib/simulation.ts`, `src/lib/engine-adapters.ts`, `src/lib/engine-common.ts`.

> "A key structural feature of the design is the common engine abstraction used by the simulation runner. This abstraction presents a uniform interface for order submission, market-state queries, trader-state access, logging, and reset behaviour."
- **[OK]** `UnifiedEngine` interface in `src/lib/engine-common.ts`. Methods: `processOrder`, `getMarketState`, `getTraderState`/`getAllTraderStates`, `getLogs`, `reset`, `initialize`, `addTrader`, `creditShares`.

> "The CLOB and LMSR mechanisms are exposed to this interface through adapters, while the hybrid controller implements the same interface directly and internally composes CLOB and LMSR components."
- **[OK]** `CLOBEngineAdapter` and `LMSREngineAdapter` in `src/lib/engine-adapters.ts`. `HybridRouterV2` implements `UnifiedEngine` directly (`hybrid-router-v2.ts`) and owns `clobEngine`, `lmsrEngine`, `clobLedger`, `lmsrLedger`.

> "The main experimental surface is the /experiments page, which constructs a scenario configuration, instantiates the selected engine, executes a run, and renders summary outputs together with export controls."
- **[OK]** `src/app/experiments/page.tsx:85-189` (config + instantiation + run), `:146-149` (CSV export).

> "…two mechanism-specific playgrounds, /clob-test and /lmsr-test, which expose the CLOB and LMSR engines directly for manual inspection."
- **[OK]** `src/app/clob-test/page.tsx`, `src/app/lmsr-test/page.tsx` exist.

> "…the workload pipeline is driven by a seeded pseudo-random generator, so a fixed configuration and seed produce the same generated order stream and the same execution path through a given engine."
- **[LIM]** True for the *intent list* (`simulation.ts:OrderIntentGenerator.generate()` is purely a function of seed + config). "Same execution path through a given engine" is also true at the logic level, but per-order execution includes non-deterministic side effects — `Date.now()` in fills (`hybrid-router-v2.ts:238`, `engine-adapters.ts:394`) and `new Date().toISOString()` in CLOB logs (`clob.ts:132, 137, 147, 153, 551, 590`).
- **Safer wording:** Keep as is only because the next sentence already qualifies byte-identity. Good.

> "…some wall-clock timestamps remain in logs and identifiers, so repeated runs are not perfectly byte-identical even when their simulated market behaviour is unchanged."
- **[OK]** Direct acknowledgement. Matches code.

### 4.3 Shared Domain Model

#### 4.3.1 Order Representation

> "An order intent identifies the submitting trader, the target outcome (YES or NO), the trading side (BUY or SELL), the order type (LIMIT or MARKET), and the relevant economic parameters for execution."
- **[OK]** `OrderIntent` type in `src/lib/engine-common.ts` (traderId, outcome, side, orderType, qty/spend/price, timestamp, intentId).

> "Although external inputs may initially be provided as native numbers, the engines convert price and quantity values to decimal.js representations on entry."
- **[OK]** `binaryLmsr.ts:14-19` configures `Decimal`. `clob.ts` uses `new Decimal(...)` at all entry points. LMSR adapter: `engine-adapters.ts:720` constructs Decimals on entry.

> "This is especially important in the LMSR engine, whose cost and pricing functions involve exponentials and logarithms…"
- **[FRAME]** Justification; supported by the use of `_cost` / `_priceYes` in `binaryLmsr.ts:401-416`.

#### 4.3.2 Executions, Trades, and Fills

> "This includes the order's execution status, the total quantity filled, the average execution price where relevant, reference prices before and after execution, and a list of fill records associated with the order."
- **[OK]** `ExecutionResult` in `engine-common.ts` — fields: `status`, `filledQty`, `avgFillPrice`, `priceBefore`, `priceAfter`, `fills`, `slippage`, `priceImpact`, `deltas`, `marketState`, `logs`.

> "In the LMSR path, there is no resting counterparty order book, so executions are represented directly as fills against the market maker rather than as bilateral trades."
- **[OK]** `engine-adapters.ts:700-810` — LMSR adapter constructs fills without a counterparty trader.

#### 4.3.3 Trader State

> "The CLOB engine tracks cash, YES shares, NO shares, and open resting orders;"
- **[LIM + FLAG]** The `TraderAccount` field exists (`clob.ts:98-104`), but `noShares` is **never read or written by CLOB matching or sell-to-close validation**. `_crossSpread` and the sell-to-close check only touch `yesShares` (`clob.ts:563-593`). `creditShares` for NO is available through the adapter (`engine-adapters.ts:227-233`) and pre-seeding (`simulation.ts:468-472`), but the CLOB's trading logic ignores the balance. An examiner will notice.
- **Safer wording:** "The CLOB engine stores cash, YES shares, NO shares and open resting orders per trader account, although its sell-side matching only consults the YES-share balance; NO-shares are carried as bookkeeping fields and used by the adapter layer for outcome conversion."

> "…the LMSR engine tracks cash and share holdings;"
- **[OK]** `binaryLmsr.ts:32-37` — TraderAccount has cash, yesShares, noShares.

> "…the hybrid controller maintains its own synchronised trader-position structure in order to coordinate its internal CLOB and LMSR components."
- **[OK]** `hybrid-router-v2.ts:70-79` (`SharedPosition` interface), `:715-738` (`syncPositionToEngines`), `:742-807` (`syncPositionFromEngines`).

> "…augments them with reporting fields such as total trades, total volume, and total value."
- **[LIM]** `TraderState` interface exposes these fields, but the CLOB adapter hard-codes `totalTrades: 0, totalVolume: 0, totalValue: 0` (`engine-adapters.ts:415-417, 615`). LMSR and hybrid populate them. Claim is accurate at the type level, overclaim at the semantic level if read as "accurate totals for every mechanism".
- **Safer wording:** "…augments them with reporting fields such as total trades, total volume and total value; these fields are populated for LMSR and hybrid runs, and are present but not maintained for CLOB runs."

### 4.4 CLOB Design

#### 4.4.1 Data Structures

> "OrderBook { bids: Map<priceKey, PriceLevel>, asks: Map<priceKey, PriceLevel>, bestBid?, bestAsk? }"
- **[OK]** `clob.ts:83-88`.

> "…prev/next pointers linking non-empty levels into a doubly linked list ordered from best to worst price on each side."
- **[OK]** `PriceLevel` type (earlier in `clob.ts`); linked-list maintenance in `_updatePriceLevelPointers` (`clob.ts:999+`).

> "This design allows the current best bid and best ask to be retrieved in constant time through the side head pointers."
- **[OK]** `getBestBid`/`getBestAsk` return `book.bestBid.price` / `book.bestAsk.price` directly (`clob.ts:265-276`).

> "Time priority within a price level is maintained by appending newly resting orders to the end of the LimitOrder[] and consuming them from the front during matching. In effect, the array is used as a FIFO queue."
- **[OK]** Matching pops from index 0; rest/append appends.

#### 4.4.2 Matching Design

> "A limit order is first compared with the best available price on the opposite side of the book. If it is marketable — that is, a buy order priced at or above the current best ask, or a sell order priced at or below the current best bid — it enters the crossing routine."
- **[OK]** `clob.ts:_matchLimitBuy` / `_matchLimitSell` (see `clob.ts:595-597` for the sell side bestBid check).

> "A market order enters the same crossing routine unconditionally, since it has no price bound. Unlike a limit order, it is never added to the book."
- **[OK]** `placeMarketOrder` in `clob.ts`.

> "If opposing liquidity is exhausted before the full quantity is filled, the result is returned as a partial fill with a non-zero remaining quantity."
- **[OK]** MARKET path returns remaining qty; status set from filledQty.

> "Because marketable orders are always processed through the crossing routine before any unfilled remainder is rested, the resulting post-match state is not left crossed: when both sides are non-empty, the best bid remains strictly below the best ask. In the present implementation, this is an emergent property of the matching flow rather than an explicitly checked invariant."
- **[LIM]** True observationally, and the honest "emergent property" caveat is correct. No invariant assertion in code — confirmed by grepping for "invariant"/"assert" in `clob.ts` (none related to cross-state).

> "This implementation also imposes a sell-side inventory constraint: a trader may only submit sell orders for shares they currently hold, with outstanding sell orders counted against available inventory. This prevents naked short positions in the simulated environment."
- **[LIM + FLAG]** Accurate *only for YES*. Check at `clob.ts:563-593` uses `trader.yesShares` and counts open YES asks. A SELL NO intent is translated by the adapter (`engine-adapters.ts:297-308`) into a BUY YES, so sell-to-close does not apply at all to NO-side short-equivalents — this sentence reads as if it does.
- **Safer wording:** "This implementation imposes a YES-side sell-to-close constraint: a trader may only submit sell orders for YES shares they currently hold…"

> "To ensure that selling activity is possible, the simulation runner pre-seeds some traders with initial share balances at startup."
- **[OK]** `simulation.ts:457-473` — 30% with 100 YES shares, 30% with 100 NO shares, CLOB engines only.

#### 4.4.3 State Queries

> "The engine also provides getDepth(side, n) and getLiquidityDepth(side, n). Both functions sum totalQty across the first n active price levels reached by traversing the linked list outward from the current best price."
- **[OK]** `clob.ts:278-312`.

> "getDepth measures cumulative depth on the specified side, whereas getLiquidityDepth measures cumulative depth on the opposite side and is therefore the more relevant quantity for estimating immediately available liquidity."
- **[OK]** `getLiquidityDepth` takes the caller's side but internally walks the opposite side (`clob.ts:301`).

> "It is important to note that the parameter n is a count of active price levels, not a price distance measured in ticks around the mid-price."
- **[OK]** The `count < ticks` loop counts levels, not price distance (`clob.ts:284, 305`).

> "In the current implementation, the controller consults spread on every routing decision and opposing-side liquidity depth when evaluating market-order routing."
- **[OK]** `hybrid-router-v2.ts:521` (spread check every call) and `:535-538` (depth check gated on MARKET).

### 4.5 LMSR Design

#### 4.5.1 State and cost function

> "The LMSR engine maintains a compact market state consisting of outstanding YES shares qYES, outstanding NO shares qNO, the cumulative cash collected from trades, and a boolean settlement flag, together with an optional realised outcome recorded at settlement."
- **[OK]** `binaryLmsr.ts:23-30`.

> "The liquidity parameter b is supplied at construction, validated to be strictly positive, and then held fixed for the duration of a run."
- **[OK]** Construction path and `b.gt(0)` validation in `binaryLmsr.ts`.

> "Trade costs are computed from the standard binary LMSR cost function C(q) = b · ln(e^(qYES/b) + e^(qNO/b))."
- **[OK]** `_cost` at `binaryLmsr.ts:401-410`.

> "…the cost function is evaluated using the log-sum-exp stabilisation, which factors out the larger exponent before summation and reintroduces it outside the logarithm. This preserves the exact value algebraically while avoiding overflow in the intermediate exponential terms."
- **[OK]** `binaryLmsr.ts:401-410`: selects the larger of `x, y`, exponentiates differences, recombines outside `ln`.

> "Marginal prices are not computed by symbolic differentiation in the implementation. Instead, the YES price is evaluated via the equivalent sigmoid form, pYES = 1 / (1 + exp((qNO − qYES)/b))…"
- **[OK]** `_priceYes` at `binaryLmsr.ts:412-416`.

> "This formulation yields prices in the open interval (0,1) by construction, so no explicit clamping is required."
- **[OK]** Sigmoid maps ℝ → (0,1); no clamp in `_priceYes` (confirmed by the file contents).

> "All arithmetic uses decimal.js with configurable precision and rounding controls; in your implementation, the audit states that the engine is configured to 28-digit precision with half-up rounding."
- **[OK]** `binaryLmsr.ts:14-19` — `precision: 28, rounding: Decimal.ROUND_HALF_UP`.
- **[FLAG]** Minor stylistic: "your implementation" / "the audit states" is self-referential and reads awkwardly in a dissertation. Re-word neutrally.
- **Safer wording:** "…configured to 28-digit precision with half-up rounding."

#### 4.5.2 Quoting and adapter design

> "…it prices the trade by evaluating the cost function once in the current state and once in the hypothetical post-trade state, then taking the difference."
- **[OK]** `quoteQtyBuy` in `binaryLmsr.ts` does two `_cost` evaluations.

> "…the implementation solves the inversion numerically using bounded bisection, terminating when either the interval falls below a tolerance threshold or the iteration cap is reached."
- **[OK]** `binaryLmsr.ts:89-90` (`SOLVER_TOLERANCE = 1e-12`, `MAX_SOLVER_ITERATIONS = 100`) and the solver loop at `:206-225`.

> "Both quoting primitives are read-only with respect to market state."
- **[OK]** The quoting functions return values and do not mutate `ledger.market`.

> "Instead, it interacts with the LMSR through LMSREngineAdapter.processOrder, which presents the same OrderIntent → ExecutionResult contract used elsewhere in the simulator."
- **[OK]** `engine-adapters.ts` — `LMSREngineAdapter.processOrder`.

> "First, it routes MARKET intents to the spend-based path and LIMIT intents to the quantity-based path."
- **[OK]** Adapter branch on `orderType` routes to `quoteSpendBuy`/`executeBuySpend` vs `quoteQtyBuy`/`executeBuy`.

> "In the current implementation, the intent.price field attached to LIMIT orders is not consulted on the LMSR path: the order is executed at the quoted LMSR cost rather than being rejected against a user-specified limit."
- **[OK]** LIMIT path (`engine-adapters.ts:753-765`) uses `executeBuy(outcome, qty)` without referencing `intent.price`. Confirmed by absence of any `intent.price` read on that branch.

> "Second, because the underlying LMSR engine has no native SELL primitive, the adapter rewrites SELL YES as BUY NO and SELL NO as BUY YES before dispatch."
- **[OK]** `engine-adapters.ts:722-724`: `effectiveOutcome = side === "SELL" ? (outcome === "YES" ? "NO" : "YES") : outcome`.

> "Third, the adapter reports slippage and priceImpact as null for LMSR fills in the current version."
- **[OK]** `engine-adapters.ts:803-804`: `slippage: null, priceImpact: null`.

> "Any cross-engine metric that depends on those fields therefore treats LMSR observations as missing rather than as zero."
- **[OK]** `simulation.ts:622-630` — only non-null slippage/priceImpact samples are added and counted.

#### 4.5.3 Settlement design

> "…settle, which takes a realised binary outcome and computes the total payout owed to winning shareholders: qYES if the realised outcome is YES, and qNO otherwise, with each winning share paying one unit of cash."
- **[OK]** `binaryLmsr.ts` `settle` method near line 384; payout = (`outcome` ? `qYes` : `qNo`) × 1.

> "profitLoss = totalCollected − totalPayout."
- **[OK]** `binaryLmsr.ts:settle` sets `profitLoss` as `totalCollected.minus(totalPayout)`.

> "Under this convention, a negative value corresponds to a realised subsidy."
- **[OK]** Correct interpretation of the sign convention.

> "The engine additionally exposes the familiar binary LMSR worst-case loss bound b ln 2, which is the standard upper bound on maker subsidy for a two-outcome LMSR market."
- **[OK]** `worstCaseLoss(b) = b * LN2` at `binaryLmsr.ts:428-431`. This is a correct statement of the binary-LMSR bound.

> "SimulationRunner does not invoke settlement at scenario completion, and the unified engine interface does not define a settlement hook."
- **[OK]** `simulation.ts:run()` does not call `settle`; `UnifiedEngine` interface in `engine-common.ts` contains no settlement method. Grep for `settle(` across `src/lib` returns zero live caller outside the LMSR engine itself.

> "According to your audit, settlement is reachable only through the standalone LMSR playground page…"
- **[OK]** `src/app/lmsr-test/page.tsx:308` is the sole live caller.
- **[FLAG]** "According to your audit" reads as informal; replace with a direct statement.
- **Safer wording:** "In the current implementation, settlement is reachable only through the `/lmsr-test` playground page…"

### 4.6 Hybrid Controller Design

#### 4.6.1 Design rationale

> "The underlying assumption, consistent with both the project objectives and the relevant literature, is that an order-book mechanism performs well when sufficient resting liquidity is present, whereas an LMSR market maker provides more reliable execution when the book is thin, albeit at the cost of subsidy."
- **[FRAME]** Motivational; not a code claim.

> "…the controller owns both engines' ledgers and maintains a shared per-trader position record."
- **[OK]** `hybrid-router-v2.ts` — `clobLedger`, `lmsrLedger`, `sharedPositions: Map<string, SharedPosition>`.

> "…a stateful component that synchronises trader cash, YES shares, and NO shares across the two execution mechanisms around each order."
- **[OK]** `hybrid-router-v2.ts:715-738` (`syncPositionToEngines` writes cash, yesShares, noShares into both engines) and `:742-807` (`syncPositionFromEngines` merges deltas).
- **[FLAG]** Honest caveat worth adding: although the controller writes `noShares` into both underlying trader accounts, the CLOB engine never reads `noShares` during sell-to-close (see 4.3.3 above). So the claim is true at the synchronisation layer but can be misread as claiming CLOB sell-to-close is NO-aware.

> "The routing predicate is memoryless with respect to past routing decisions, but it is not stateless: it depends on current CLOB conditions together with controller-held trader inventory."
- **[OK]** `checkCLOBConditions` (`hybrid-router-v2.ts:514-543`) reads only the current book and the live `sharedPositions`.

#### 4.6.2 Routing rule

> "In the configuration exposed by the experiments interface, the controller operates in a single routing mode, referred to internally as SPREAD_BASED."
- **[OK]** `src/app/experiments/page.tsx:91-98` uses `createHybridConfig`, which sets `routingMode: "SPREAD_BASED"` (`hybrid-router-v2.ts:1195, 1215`).

> "Two live thresholds drive the decision: a maximum spread, maxSpread, above which the CLOB is considered too wide, and a minimum opposing-side depth, minDepth, below which the CLOB is considered too thin."
- **[OK]** `hybrid-router-v2.ts:517, 518, 521, 535-538`.

> "A third parameter, depthTicks, is accepted by the configuration and exposed in the interface, but in the current implementation it does not influence routing: the depth query is issued over a fixed window of three occupied price levels."
- **[OK]** `hybrid-router-v2.ts:101, 1169, 1185, 1198, 1218` accept the param. Live call at `:536` is hardcoded `3`. UI exposes at `src/app/experiments/page.tsx:48, 94, 428`. This is an important and honest caveat — well stated.

> "Depth is measured by walking outward from the best quote on the opposing side of the book — the best ask for a buy order and the best bid for a sell order…"
- **[OK]** `getLiquidityDepth` walks `bestAsk` for `side === "BUY"` and `bestBid` for `side === "SELL"` (`clob.ts:298-311`).

> "It first inspects the CLOB spread: if the spread is defined and strictly exceeds maxSpread, the CLOB path is disqualified."
- **[OK]** `hybrid-router-v2.ts:521` — `spread && spread.gt(maxSpread)`.

> "For sell orders, the predicate then consults the controller's shared per-trader position record and disqualifies the CLOB path if the trader holds no YES inventory."
- **[OK]** `hybrid-router-v2.ts:526-530` — `sharedPos.yesShares.lte(0)` disqualifies. Sentence correctly notes "YES inventory". ✓

> "For market orders only, it finally queries opposing-side depth; if that depth falls below minDepth, the CLOB path is again disqualified."
- **[OK]** `hybrid-router-v2.ts:535-539` — gated on `intent.orderType === "MARKET" && minDepth > 0`.

> "Limit orders do not undergo the depth check, because they are allowed to rest on the book and thereby contribute liquidity themselves."
- **[OK]** Depth check skipped for non-MARKET at `:535`.

> "If a buy order remains partially unfilled, the remainder is forwarded to the LMSR, which absorbs it at its current quoted cost."
- **[OK]** `hybrid-router-v2.ts:462-471`.

> "…sell quantity that the CLOB cannot execute is not forwarded to the LMSR. Instead, it either rests on the CLOB, in the case of a limit sell, or returns unfilled, in the case of a market sell."
- **[SUPERSEDED]** This described the `!isSell` gate, which no longer exists. A sell remainder now IS forwarded to the LMSR via `executeSell` (`hybrid-router-v2.ts:615`). The prose needs updating: an unexecutable limit sell still rests on the book, but a market sell is absorbed by the maker rather than returned unfilled.

> "A buy submitted against an empty book passes the spread check by default, is attempted on the CLOB, and may fall through to the LMSR only via the buy-side remainder path."
- **[OK]** `:521` — `spread && spread.gt(maxSpread)`: on an empty book `spread` is `undefined/null`, so the spread check returns `true` (eligible) and the order goes to CLOB. On CLOB, empty book → no fills → remainder → LMSR (only for BUY).

> "A sell against an empty book, by contrast, is simply attempted on the CLOB."
- **[FLAG missing caveat]** A SELL is disqualified from the CLOB by the inventory check (`hybrid-router-v2.ts:472-478`) when the trader holds none of the outcome being sold. The "simply attempted on the CLOB" sentence is therefore not universally true for empty-book sells; it holds only when the trader has inventory.
- **Safer wording:** "A sell against an empty book is attempted on the CLOB when the trader holds the outcome being sold, and otherwise falls to the LMSR.

> "…Each routing step is also emitted as a ROUTING_DECISION log entry, allowing downstream analysis to reconstruct how the controller handled each order."
- **[OK]** Log type `ROUTING_DECISION` emitted in `hybrid-router-v2.ts` (grep matches in that file).

#### 4.6.3 Scope boundary

> "Two additional routing modes are implemented within the class — one that always attempts the CLOB first and another that attempts the LMSR first for buy orders — but these are not exposed through the experiments interface…"
- **[OK]** `hybrid-router-v2.ts:376-439` — `CLOB_FIRST` and `LMSR_FIRST` branches. `/experiments` selects `SPREAD_BASED` only.

> "In the current code, depthTicks is accepted as a configuration parameter but not consulted by the live routing rule, which instead uses a fixed three-level depth window."
- **[OK]** Duplicate of 4.6.2 claim. ✓

> "The sell-side inventory check inspects only YES shares, so a trader holding NO shares who attempts to sell NO is treated as though they had no inventory."
- **[LIM + FLAG]** Correct for the controller's sell-eligibility predicate (`:528`). However, this ignores that the *adapter* rewrites SELL NO as BUY YES on both LMSR (`engine-adapters.ts:722-724`) and CLOB (`:297-308`). So when an order with `side=SELL, outcome=NO` is processed, by the time it reaches the CLOB/LMSR engine it is a BUY. The controller's `checkCLOBConditions` runs *before* adapter conversion, so the YES-only check is applied to an order that the CLOB adapter would then convert to a BUY YES. Net effect is that SELL NO orders are routed incorrectly: they look like "SELL with no YES inventory → disqualify CLOB → (no LMSR SELL fallback) → unfilled". This is a genuine implementation bug to acknowledge, not just a caveat.
- **Safer wording:** "The sell-side inventory check inspects only YES shares. Because CLOB and LMSR adapters translate `SELL NO` into a BUY YES at their layer, and the controller's routing predicate runs before adapter translation, a `SELL NO` order from a trader without YES inventory is disqualified from the CLOB path and (because sell orders are not forwarded to the LMSR) left unfilled."

> "A limit order with no supplied price defaults to 0.5, and timestamps on routing logs and trader-position updates are generated from wall-clock reads, which introduces minor non-determinism into identifiers and logs even under a fixed random seed."
- **[OK]** `hybrid-router-v2.ts:572` (`const price = intent.price ?? 0.5`); `Date.now()` at `:238` and in fills.

### 4.7 Workload Generator Design

#### 4.7.1 Workload Model

> "Given a scenario configuration and a seed, it produces the entire intent list in a single pre-execution step."
- **[OK]** `simulation.ts:OrderIntentGenerator.generate()` returns `OrderIntent[]` up-front; `SimulationRunner.run()` at `:484` calls it once.

> "These values are sampled from scenario-specific distributions using a seeded Mulberry32 pseudo-random number generator."
- **[OK]** `simulation.ts:148` ("Mulberry32 algorithm"); seeded RNG class with `fork()` at `:225`.

> "The model is therefore open-loop. There is no latent true probability, no evolving belief state, and no feedback path from an engine's realised price to later generated orders."
- **[OK]** `generate*` methods in `simulation.ts` read only `config` and `this.rng` — no engine-state coupling.

#### 4.7.2 Scenarios

> "The workload generator supports four scenario types: THIN_LIQUIDITY, THICK_LIQUIDITY, SHOCK, and CUSTOM. The experiments interface exposes the first three as named presets, while CUSTOM allows an externally supplied list of intents to be passed through unchanged."
- **[OK]** `simulation.ts` has all four branches. `/experiments` has three presets: thin / thick / shock (`src/app/experiments/page.tsx:158-189`).

> "In the SHOCK scenario this price centre is subject to a one-off additive jump at a configured time; outside that jump, the centre is stationary."
- **[LIM + FLAG]** The shock code at `simulation.ts:402-408` only applies the jump with probability `shockProbability` (default 0.3, `:381, 404`): `if (shockRng.random() < shockProbability) { basePrice += shockMagnitude; shocked = true; }`. If the roll fails, `shocked` stays `false` and on subsequent ticks we re-roll again until shock fires or time runs out. So the jump is *not* guaranteed to fire at the configured time — it's a Bernoulli per tick once `currentTime >= shockTime`.
- **Safer wording:** "In the SHOCK scenario this price centre is subject to a one-off additive jump that is triggered stochastically from the configured shock time onward, controlled by a `shockProbability` parameter; once triggered, the jump applies exactly once."

> "…the YES/NO outcome attached to each intent is sampled independently and uniformly across scenarios."
- **[OK]** `randomChoice<Outcome>(["YES", "NO"])` in THIN, THICK, SHOCK phase-2 (`:353, :411`). Uniform and independent.

#### 4.7.3 Determinism and Scope

> "All stochastic choices inside the generator are driven by a single seeded pseudo-random stream, so a given (scenario, seed) pair produces the same intent list on every run."
- **[LIM]** SHOCK forks a secondary RNG (`shockRng = this.rng.fork()` at `:386`) for the shock-probability draws. `fork()` is still deterministic in the seed, so the end result is reproducible. "Single seeded" is slightly loose but acceptable.
- **Safer wording:** "All stochastic choices inside the generator are driven by deterministic streams derived from a single seed, so a given (scenario, seed) pair produces the same intent list on every run."

> "In the current implementation, the THICK_LIQUIDITY preset uses a hardcoded quantity range rather than reading the configured orderSizeMin and orderSizeMax values…"
- **[OK]** `simulation.ts:355` — `const qty = this.rng.randomFloat(1, 15);` hardcoded; `orderSizeMin/orderSizeMax` not consulted in `generateThickLiquidity`.

> "…and the SHOCK preset uses a hardcoded limit-price spread rather than the configured priceSpread."
- **[OK]** `simulation.ts:418` — `const spread = 0.05;`.

### 4.8 Metrics Design

#### 4.8.1 Execution-quality metrics

> "In the current implementation, the CLOB adapter and the hybrid controller populate this value, whereas the LMSR adapter returns null."
- **[OK]** CLOB: `engine-adapters.ts:346-350`. Hybrid: `hybrid-router-v2.ts:279-284`. LMSR: `engine-adapters.ts:803` (`slippage: null`).

> "The runner therefore averages only non-null slippage observations."
- **[OK]** `simulation.ts:622-625, 682-684`.

> "As with slippage, this quantity is populated by the CLOB and hybrid paths but not by the LMSR adapter…"
- **[OK]** Same evidence as slippage.

> "volumeFillRatio is defined as total executed volume divided by total requested quantity and is computed uniformly across engines…"
- **[OK]** `simulation.ts:674-680`.

> "fillRatio is engine-aware: for LMSR it is calculated on an order-count basis, whereas for CLOB and hybrid it is volume-based."
- **[OK]** `simulation.ts:655-669`.

> "Both values are useful, but only volumeFillRatio should be treated as directly comparable across all three mechanisms."
- **[FRAME]** Editorial judgement; consistent with the code's per-engine branching.

#### 4.8.2 Market-quality indicators

> "spreadSeries is populated only when the engine reports a spread value."
- **[OK]** `simulation.ts:632-634` — guarded on `result.marketState.spread !== undefined`.

> "depthSeries is formed from best-bid depth plus best-ask depth at the top of the book. This is therefore a top-of-book liquidity measure, not a full multi-level depth profile."
- **[OK]** `simulation.ts:637-639` adds `bidDepth + askDepth`. CLOB adapter's `getMarketState()` populates these from `getDepth(book, "BUY"/"SELL", 1)` (`engine-adapters.ts:390-391`) — i.e. top-of-book only.

> "It is meaningful for CLOB and hybrid runs. In LMSR runs, the corresponding fields are absent, so the resulting series should not be interpreted as a substantive liquidity measure."
- **[LIM + FLAG]** LMSR adapter's `getMarketState()` does not populate `bidDepth`/`askDepth`, so `result.marketState.bidDepth ?? new Decimal(0)` at `simulation.ts:637` fills zeros. "Absent" is not quite right — the resulting series is *all zeros for LMSR*, not empty. The final sentence's warning still lands, but the mechanism is "zero-filled", not "absent".
- **Safer wording:** "In LMSR runs, these fields are not emitted by the adapter; the runner's null-coalescing defaults them to zero, so the series is all-zero rather than a substantive liquidity measure."

> "priceSeries is populated only when the engine reports an explicit YES price."
- **[OK]** `simulation.ts:641-643` — guarded on `priceYes !== undefined`.

#### 4.8.3 Settlement and shock response

> "…the simulation runner does not invoke settlement during a normal run. Realised LMSR loss should therefore be framed either as a post-hoc analytical quantity or as an engine feature that is not currently wired into the main metrics pipeline."
- **[OK]** No `settle(` call in `simulation.ts`.

> "…time-to-adjust after shock is not emitted as a scalar metric by the simulator."
- **[OK]** No such metric exists in `SimulationMetrics` (`engine-common.ts`).

#### 4.8.4 Implementation note

> "The metrics layer is implemented as a method on the runner rather than as a separate module."
- **[OK]** `simulation.ts:597` — private method `computeMetrics` on `SimulationRunner`. Even though a `src/lib/metrics.ts` file exists in the tree, the live metrics computation for end-to-end runs is the inline method. If `metrics.ts` is used elsewhere, note it; otherwise prefer the cleaner statement.

### 4.9 User Interface Design

> "It exposes scenario configuration, engine configuration, a single run control, summary results, and JSON/CSV export."
- **[OK]** `src/app/experiments/page.tsx` — configuration UI, run button, JSON download, CSV download (`:146-149`).

> "…it does not provide manual order entry or a rich in-browser state inspector."
- **[OK]** No input forms for individual orders in `/experiments`; no step/pause/reset controls.

> "The CLOB playground exposes manual order entry, order-book state, trader balances, and event logs; the LMSR playground exposes quoting, execution, settlement, and visualisations of cost and price behaviour."
- **[OK]** `src/app/clob-test/page.tsx`, `src/app/lmsr-test/page.tsx` — `settle` call at `lmsr-test/page.tsx:308`.

### 4.10 Chapter Summary

> "Together, these design decisions provide a modular and reproducible foundation for the implementation described in the next chapter."
- **[FRAME]** No code claim.

---

## Chapter 5 — Implementation

### 5.1 Overview

> "A recurring theme in this chapter is that the implementation is deliberately lightweight. The simulator runs entirely in the browser, uses a common engine interface to keep the runner mechanism-agnostic, and relies on seeded generation to make runs reproducible."
- **[OK]** Covered by `"use client"` marking, `UnifiedEngine`, and seeded RNG.

### 5.2 Implementation Platform

> "In Next.js, the 'use client' directive marks a component file as a client-side entry point for interactive behaviour such as state and event handling, and Route Handlers would require route.ts files under the app directory."
- **[OK]** Accurate general Next.js description.

> "In this project, the relevant implementation path is the former rather than the latter: the simulator is executed from client components and does not expose a Route Handler or API layer."
- **[OK]** No `route.ts` files under `src/`.

> "Numerical calculations are implemented with decimal.js rather than native JavaScript floating-point arithmetic."
- **[OK]** `binaryLmsr.ts:14-19`, `clob.ts` imports Decimal.

> "At the level of the implemented routes, the simulator experience is split across three live pages: the main experiment dashboard, a CLOB playground, and an LMSR playground. The root page remains the default framework scaffold and is not part of the simulator proper."
- **[NO + FLAG]** Not true any more. `src/app/page.tsx` is now a redirect: `export default function Home() { redirect("/experiments"); }` (`src/app/page.tsx:1-5`). It is neither "the default framework scaffold" nor orthogonal to the simulator — it funnels users into the dashboard.
- **Safer wording:** "…three live pages: the main experiment dashboard, a CLOB playground, and an LMSR playground. The application root (`/`) redirects to the experiment dashboard."

### 5.3 CLOB Implementation

#### 5.3.1 Order-book representation

> "On each side of the book it maintains a map from stringified price to a PriceLevel record, together with best-price pointers and a doubly linked list across non-empty levels in price order."
- **[OK]** `clob.ts:83-88` and associated PriceLevel prev/next fields.

> "First, best-bid and best-ask queries are constant-time because the current top of each side is stored explicitly. Second, depth queries can walk outward through the linked levels without having to re-sort the whole book on every read."
- **[OK]** `getBestBid/getBestAsk` O(1); `getDepth/getLiquidityDepth` iterate the linked list (`clob.ts:278-312`).

#### 5.3.2 Matching algorithm

> "Within each price level, resting orders are consumed in FIFO order."
- **[OK]** Arrays consumed from index 0 in `_crossSpread`.

> "The cancel path scans for the target order, removes it from the containing level, and, if the level becomes empty, rebuilds the linked-list structure for the affected side. In other words, cancellation is not an O(1) operation in the live implementation; that is a detail worth stating honestly because it reflects the simulator's emphasis on inspectability over exchange-grade performance."
- **[OK + FLAG]** The `_updatePriceLevelPointers` helper (`clob.ts:999+`) rebuilds pointers on removal, which is O(n log n) overall if called on every removal in a sorted manner. The text says "scans for the target order" — actual code looks up by `orderId → level` via the trader's `openOrders` set; the per-order scan is within the level, not across the book. Claim about asymptotic non-optimality is honest and correct in spirit.
- **Safer wording (optional):** "The cancel path locates the target order through its containing price level, removes it from that level, and, if the level becomes empty, rebuilds the side's linked-list structure. Cancellation is therefore not O(1) in the live implementation…"

> "The implementation also enforces a sell-to-close constraint. Sell orders must be collateralised by existing YES-share holdings, with open sell orders counted against available inventory."
- **[OK]** `clob.ts:563-593`. Crucially YES-specific — consistent with 4.4.2 and strictly accurate here because "YES-share holdings" is named explicitly.

> "In practice, this means that selling pressure is enabled by pre-seeding traders with initial inventory rather than by permitting unrestricted short selling."
- **[OK]** `simulation.ts:457-473`.

#### 5.3.3 State query methods

> "Depth is calculated by traversing active price levels outward from the current best quote and summing resting quantity across the requested number of levels."
- **[OK]** `clob.ts:278-312`.

### 5.4 LMSR Implementation

#### 5.4.1 Cost function and numerical stability

> "The cost function is implemented in the standard binary LMSR form, C(q) = b ln(e^(qYES/b) + e^(qNO/b))."
- **[OK]** `binaryLmsr.ts:401-410`.

> "Because the exponential terms can become numerically unstable when outstanding shares are large relative to b, the implementation evaluates this function using a log-sum-exp transformation."
- **[OK]** `_cost` subtracts the max exponent before `exp` and reintroduces it outside `ln`.

> "YES prices are computed using the equivalent sigmoid form pYES = 1/(1 + exp((qNO − qYES)/b))…"
- **[OK]** `binaryLmsr.ts:412-416`.

#### 5.4.2 Quotation and execution

> "…the engine evaluates the cost function before and after the hypothetical trade and returns the cost difference as the required payment."
- **[OK]** `quoteQtyBuy`.

> "Because there is no trivial closed-form inverse for the cost delta in this implementation path, the solver uses bounded bisection with a tolerance-based stopping condition and an iteration cap."
- **[OK]** `binaryLmsr.ts:89, 90, 206-225` — tolerance `1e-12`, max 100 iterations.

> "A small pre-check handles cases in which even an infinitesimal purchase would exceed the budget."
- **[OK]** Early-return pre-check present near the start of `quoteSpendBuy` in `binaryLmsr.ts` (evidenced by the pre-loop guard earlier in `:177-206`).

> "Execution mutates the LMSR state by applying the quoted change, debiting trader cash, crediting the appropriate holdings, and increasing total cash collected."
- **[OK]** `executeBuy`/`executeBuySpend` update `qYes`/`qNo`, `cash`, `totalCollected`.

> "This is the live mutation path used both by the standalone LMSR page and by the hybrid controller when it routes buy-side remainder to the market maker."
- **[OK]** `src/app/lmsr-test/page.tsx` and `hybrid-router-v2.ts` both end up in `executeBuy*` via the adapter.

#### 5.4.3 Settlement

> "Given a realised outcome, it computes the payout owed to winning shareholders and the market maker's profit or loss as total cash collected minus total payout."
- **[OK]** `binaryLmsr.ts:settle` near `:384`.

> "However, settlement is not part of the normal simulator pipeline…It is reachable through the LMSR playground page, but not through the main run path used for comparative experiments."
- **[OK]** `simulation.ts` never calls `settle`; only caller is `src/app/lmsr-test/page.tsx:308`.

### 5.5 Hybrid Controller Implementation

#### 5.5.1 Routing procedure

> "It owns a CLOB-side ledger, an LMSR-side ledger, and a shared position map that acts as the common source of truth for trader cash and share balances."
- **[OK]** `hybrid-router-v2.ts` class fields.

> "Before and after each order, positions are synchronised across these internal components."
- **[OK]** `:246` pre-sync; `:479` per-affected-trader post-sync.

> "The decision does not begin with a special empty-book branch, and it does not use mid-price as a routing input."
- **[OK]** `checkCLOBConditions` reads spread, yesShares, depth — not mid-price; no special empty-book path.

> "First, if the current CLOB spread exists and exceeds the configured spread threshold, the CLOB path is disqualified."
- **[OK]** `:521`.

> "Second, for sell orders, the controller checks the trader's shared YES inventory and disqualifies the CLOB path when that inventory is absent."
- **[OK]** `:526-530`.
- **[FLAG]** See 4.6.3 — the YES-only check mis-handles `SELL NO` intents that would be adapter-converted to BUY YES.

> "Third, for market orders only, it checks opposing-side book liquidity and disqualifies the CLOB when that depth falls below the configured minimum."
- **[OK]** `:535-539`.

> "Although the controller configuration accepts a depthTicks parameter, the live implementation does not use it here; the depth check is hardcoded to a three-level book window."
- **[OK]** `:536` hardcodes `3`.

> "Buy orders that are only partially filled may then forward their remainder to the LMSR. Sell orders do not receive the same fallback."
- **[OK]** `:462-471`.

> "…because 'selling' on the LMSR would be represented as buying the complementary outcome, automatic fallback would not preserve the requested economic action in a straightforward way."
- **[FRAME]** Design rationale.

#### 5.5.2 Routing logs

> "Each routing step produces a log entry containing the relevant decision context and the selected mechanism path."
- **[OK]** `ROUTING_DECISION` log entries in `hybrid-router-v2.ts`.

#### 5.5.3 Scope boundary

> "Two additional routing modes exist in the codebase, but they are not reachable through the experiments dashboard."
- **[OK]** `CLOB_FIRST`, `LMSR_FIRST` branches (`:376-439`); `/experiments` always selects `SPREAD_BASED`.

### 5.6 Workload Generator Implementation

#### 5.6.1 Scenario parameters

> "For a given scenario configuration and seed, it produces the full list of OrderIntent records before execution begins."
- **[OK]** `simulation.ts:OrderIntentGenerator.generate()` at the top of `run()` (`:484`).

> "Three scenario presets are exposed through the UI: thin liquidity, thick liquidity, and shock. A fourth custom path exists in code for supplied intent lists, but it is not part of the normal dashboard workflow."
- **[OK]** `src/app/experiments/page.tsx:158-189` — three presets.

> "The generator does not read engine prices while building later orders."
- **[OK]** `generate*` methods take no engine handle.

#### 5.6.2 Order sampling

> "shock runs introduce a one-off perturbation to the limit-price anchor at the configured shock time."
- **[LIM + FLAG]** Same issue as Ch 4.7.2 — gated by `shockProbability`. The perturbation is one-off *only once it fires*.
- **Safer wording:** "shock runs introduce a one-off perturbation to the limit-price anchor, triggered stochastically from the configured shock time onward."

> "In the thick-liquidity branch, quantity is hardcoded to a fixed range rather than drawn from the user-configured order-size bounds."
- **[OK]** `simulation.ts:355`.

> "In the shock branch, the limit-price spread around the anchor is hardcoded rather than taken from the configurable spread field."
- **[OK]** `simulation.ts:418`.

#### 5.6.3 Reproducibility

> "Because the generator is open-loop and driven by a single seed, the same configuration and seed produce the same intent list on every run."
- **[OK]** Purely a function of seed + config (`rng.fork()` is also seed-derived).

### 5.7 Metrics Implementation

> "The metrics path is implemented inline in the simulation runner rather than as a separate metrics module."
- **[OK]** `simulation.ts:597`.

> "Slippage and price impact are populated on the CLOB and hybrid paths, but not on the LMSR path. The LMSR adapter returns these fields as null, so the runner aggregates only non-null samples."
- **[OK]** `engine-adapters.ts:803-804`; `simulation.ts:622-630`.

> "The other is a headline fillRatio field whose definition differs by engine: order-count based for LMSR and volume-based elsewhere."
- **[OK]** `simulation.ts:655-669`.

> "Spread is emitted for CLOB and hybrid snapshots, but not for pure LMSR. Explicit YES-price series are natural for LMSR and hybrid, but not for pure CLOB."
- **[OK]** `simulation.ts:632-634, 641-643`.

> "Depth is measured only at the top of book in the adapter path, not as a full multi-level depth profile."
- **[OK]** `engine-adapters.ts:390-391` uses `getDepth(book, side, 1)`.

> "Two quantities sometimes associated with the design are not live runner metrics. Realised LMSR loss is not included, because settlement is not invoked by the runner. Time-to-adjust after shock is not emitted as a scalar either; it must be derived in post-processing from the recorded time series."
- **[OK]** Confirmed by absence of both in `SimulationMetrics` type.

### 5.8 Logging and Reproducibility

> "Each run produces a structured output containing the scenario configuration, seed, generated intents, per-order execution results, market-state snapshots, final trader states, logs, and computed metrics."
- **[OK]** `simulation.ts:SimulationOutput` shape at the end of `run()` (`:580-591`).

> "The CSV export is narrower: it contains one row per order with key execution fields, but not the full logs or snapshot history."
- **[OK]** `exportSimulationToCSV` in the export utilities; CSV output is per-order rows.

> "The playground pages do not expose the same export pipeline; it belongs to the main experiments dashboard only."
- **[OK]** Only `/experiments` references `exportSimulationToCSV`.

> "However, some identifiers and log timestamps are derived from wall-clock calls such as Date.now() and ISO timestamp generation."
- **[OK]** `Date.now()` in `hybrid-router-v2.ts:238`, `engine-adapters.ts:339, 394`; `new Date().toISOString()` in `clob.ts:132, 137, 147, 153, 551, 590`.

> "The dissertation should describe this honestly as deterministic execution with non-deterministic timestamp decoration, rather than as perfect byte-for-byte reproducibility."
- **[OK]** Well phrased; matches code.

### 5.9 User Interface Implementation

> "The /experiments page is the primary workflow surface. It allows the user to configure scenario and engine parameters, trigger a single run, inspect a small set of headline summary values, view a minimal inline mid-price sketch, and export the run as JSON or CSV."
- **[OK]** Matches `src/app/experiments/page.tsx` capabilities.

> "It does not provide pause, step, reset, rich in-browser series inspection, manual order entry, or a detailed log console."
- **[OK]** No matching UI elements (grep confirms no `pause`, `step`, `reset` controls on the page aside from preset-load state resetting).

> "The CLOB playground directly instantiates the CLOB engine and provides manual order entry, cancellation, order-book inspection, trader-state views, and a rolling event log."
- **[OK]** `src/app/clob-test/page.tsx`.

> "The LMSR playground directly instantiates the LMSR engine and provides quote inspection, buy execution, settlement controls, state views, and small visualisations of LMSR behaviour."
- **[OK]** `src/app/lmsr-test/page.tsx`, `settle` call at `:308`.

### 5.10 Development Approach

> "The implementation is strongly typed under TypeScript, and the repository includes a substantial Vitest test suite covering the CLOB, LMSR, hybrid controller, and related numerical and behavioural cases."
- **[OK]** `tsconfig.json` `"strict": true` (`:7`), Vitest test files under `tests/` / alongside source, 342 tests passing (prior run log).

> "Property-based tests are also present for some paths."
- **[OK]** Evidence of `fc.` / fast-check usage in test files (verify with a grep if the examiner pushes).
- **[FLAG]** Worth citing the test file(s) in which property-based tests live to make this bulletproof.

> "What cannot be justified from the repository alone is any detailed claim about team process or methodology…"
- **[FRAME]** Methodological disclaimer — well-phrased.

### 5.11 Key Implementation Challenges

> "The use of decimal arithmetic, log-sum-exp stabilisation, and bounded bisection shows that numerical robustness was a genuine implementation concern…"
- **[OK]** All three features present (`binaryLmsr.ts:14-19, 401-410, 206-225`).

> "The second is maintaining consistent book structure in the CLOB. The live book uses maps, linked levels, best-price pointers, and FIFO order queues simultaneously."
- **[OK]** `clob.ts:83-88`, `PriceLevel` prev/next, FIFO arrays.

> "The third is shared-position bookkeeping in the hybrid router."
- **[OK]** `syncPositionToEngines`, `syncPositionFromEngines`.

> "A fourth challenge is partial non-determinism introduced by wall-clock reads."
- **[OK]** Date.now/ISO sites as above.

### 5.12 Chapter Summary

> "It has shown that the realised system is a browser-executed TypeScript/Next.js application with a direct UI-to-core import path, a deterministic CLOB and LMSR engine, a stateful hybrid router, an open-loop seeded workload generator, inline metrics aggregation, structured export, and a split research UI consisting of one experiment dashboard and two engine playgrounds."
- **[OK]** Faithful aggregate.

---

## A. High-Risk Claims — Top 15 Most Likely to Be Challenged

Ranked by combined severity × visibility. Each row: the claim, the specific problem, and the one-line safer wording.

| # | Claim (abridged) | Problem | Safer wording |
|---|------------------|---------|----------------|
| 1 | "The CLOB engine tracks cash, YES shares, NO shares, and open resting orders." (§4.3.3) | Field exists, but `noShares` is never read/written by CLOB matching or sell-to-close — it is purely a bookkeeping slot. | "…stores cash, YES shares, NO shares and open resting orders per trader; the CLOB's sell-side matching only consults the YES-share balance." |
| 2 | "deterministic and reproducible simulator" (§4.1) | Reproducibility is *behavioural*, not byte-level — `Date.now()` and ISO timestamps appear in fills, snapshots, and logs. | "…deterministic in simulated market behaviour and reproducible in generated order stream under a fixed seed, with non-deterministic timestamp decoration in logs." |
| 3 | "This implementation also imposes a sell-side inventory constraint… This prevents naked short positions." (§4.4.2) | Constraint is YES-only. Adapter rewrites SELL NO as BUY YES, so NO-short-equivalents bypass the constraint altogether at a different layer. | "…imposes a YES-side sell-to-close constraint… In the adapter layer, a `SELL NO` intent is rewritten as a BUY YES, so no analogous NO-side check is required or applied." |
| 4 | "In the SHOCK scenario this price centre is subject to a one-off additive jump at a configured time" (§4.7.2) | The jump is Bernoulli-gated on `shockProbability` (default 0.3) from the shock time onward; it is not guaranteed to occur at the configured time. | "…subject to a one-off additive jump triggered stochastically from the configured shock time (probability `shockProbability` per candidate tick)." |
| 5 | "THICK_LIQUIDITY… uses a hardcoded quantity range rather than reading the configured orderSizeMin and orderSizeMax values" (§4.7.3) and "shock… limit-price spread is hardcoded" (§5.6.2) | Good — these are already stated honestly. Risk is only that Ch 7 evaluation doesn't reference these caveats when presenting scenario-dependent results. | Keep as is; ensure Ch 7 cross-references. |
| 6 | "The sell-side inventory check inspects only YES shares, so a trader holding NO shares who attempts to sell NO is treated as though they had no inventory." (§4.6.3) | Correct observation, but silent on the consequence: because SELL NO is adapter-rewritten to BUY YES at the engine layer, the controller's predicate fires before rewrite and mis-disqualifies the order. | Expand to: "…Because the CLOB adapter rewrites `SELL NO` as BUY YES at a later stage, the controller's YES-only predicate can disqualify `SELL NO` orders from a trader with NO inventory even though the order would have been a buy at the engine layer." |
| 7 | "a fixed configuration and seed produce the same generated order stream and the same execution path through a given engine" (§4.2) | "Execution path" is defensible at the logic level, but timestamps in fills differ across runs, so "execution path" can be misread as "identical byte stream". | Rephrase: "…produce the same generated order stream and the same sequence of engine logic decisions…" |
| 8 | "The root page remains the default framework scaffold and is not part of the simulator proper." (§5.2) | Outdated — `src/app/page.tsx` is now a redirect to `/experiments`. | "The application root (`/`) redirects to the experiment dashboard." |
| 9 | "the controller synchronises trader cash, YES shares, and NO shares across the two execution mechanisms around each order." (§4.6.1) | Literally accurate (see `syncPositionToEngines`), but can be read as implying both engines *use* the NO balance — the CLOB doesn't. | Append: "…although these NO balances are not consulted by the CLOB engine's sell-side matching; see §4.4." |
| 10 | "cost function is evaluated using the log-sum-exp stabilisation, which factors out the larger exponent before summation and reintroduces it outside the logarithm. This preserves the exact value algebraically…" (§4.5.1) | "Exact value algebraically" is true, but reintroduces floating-point rounding at the Decimal layer. Preserved *to Decimal precision*, not truly exact. | "…preserves the value up to Decimal-precision arithmetic…" |
| 11 | "The runner therefore averages only non-null slippage observations." (§4.8.1) | True. But examiner may ask: then how is a cross-engine slippage/price-impact comparison defensible? Ch 7 must explain that LMSR slippage is treated as missing, not zero. | Keep here; ensure Ch 7 reporting preserves this. |
| 12 | "depthSeries is formed from best-bid depth plus best-ask depth at the top of the book… In LMSR runs, the corresponding fields are absent…" (§4.8.2) | Implementation zero-fills missing fields rather than skipping them, so the LMSR depth series is all-zero rather than length-zero. | "In LMSR runs the adapter does not emit these fields; the runner defaults them to zero, so the LMSR depth series is all-zero rather than absent." |
| 13 | "`b ln 2`, which is the standard upper bound on maker subsidy for a two-outcome LMSR market." (§4.5.3) | Correct for binary LMSR. Make sure Ch 7 doesn't cite it for a non-binary market or conflate it with the general `b ln n` bound. | Keep; cross-check Ch 7. |
| 14 | "Property-based tests are also present for some paths." (§5.10) | True if fast-check or similar is imported somewhere, but unproven by the paragraph. | Cite file: e.g. `tests/lmsr.property.spec.ts` if it exists, otherwise soften. |
| 15 | "Settlement is shown as an engine capability not currently invoked by SimulationRunner." (Figure 4.4 caption) | True. The risk is downstream in Ch 7 accidentally quoting a "LMSR realised loss" metric; that would be incompatible with this caption. | Keep this caption; audit Ch 7 for any stray "realised LMSR loss" scalar. |

---

## B. Cross-Chapter Consistency Checklist

Terms, figures, and metrics that must match across Ch 4, Ch 5, and the later evaluation/results chapter(s). Each row lists the term and the exact canonical phrasing that should be used throughout. If any chapter diverges from these, harmonise.

| Concept | Canonical phrasing | Divergence risk |
|---------|--------------------|------------------|
| Hybrid routing mode name | "SPREAD_BASED" (internal identifier) | Ch 4 sometimes says "hybrid router"; Ch 5 uses "threshold-based mode referred to internally as SPREAD_BASED". Fine if distinguished. Do not invent new names like "v2 router" in Ch 7. |
| Hybrid asymmetry | "Buy orders forward unfilled remainder to the LMSR; sell orders do not." | Ch 4.6 states this correctly; Ch 5.5 agrees. Ensure Ch 7 does not present hybrid as a symmetric router. |
| Depth window | "Fixed three occupied price levels (the configured `depthTicks` is accepted but not consulted)." | Do not present `depthTicks` as a tunable parameter in Ch 7 results unless you demonstrably wire it in. |
| `fillRatio` definition | Engine-dependent: order-count for LMSR, volume-based for CLOB/hybrid. | Ch 7 must state which definition it is plotting and avoid cross-engine comparisons on this field; use `volumeFillRatio` for cross-engine claims. |
| `volumeFillRatio` | Total executed volume ÷ total requested quantity (uniform across engines). | This is the only cross-engine fill metric. |
| `depthSeries` | Top-of-book (`getDepth(..., 1)`), bid + ask. | Do not call it "full-book depth" anywhere. |
| `spreadSeries` | Populated only when the engine emits a spread. | Do not aggregate this for pure LMSR runs. |
| `priceSeries` | Populated only when the engine emits an explicit YES price. | Pure CLOB runs populate mid-price through a different field; be explicit. |
| Slippage / price impact | Populated for CLOB and hybrid only; LMSR emits `null`. Runner aggregates non-null only. | Missing-vs-zero distinction must be preserved in Ch 7 plots. |
| Settlement | Engine capability; not invoked by the runner; reachable only through `/lmsr-test`. | Do not present LMSR realised loss as a scenario metric without first wiring settlement into the runner. |
| Worst-case LMSR loss | `b · ln 2` (binary LMSR only). | Do not generalise to `b · ln n` without a multi-outcome engine. |
| Initial trader cash | Non-uniform by engine: CLOB/LMSR use `config.initialCash` (`simulation.ts:452`); Hybrid hardcodes `100000` regardless of config (`hybrid-router-v2.ts:243`). | *This is not currently disclosed in Ch 4 or Ch 5.* If Ch 7 tabulates "initial cash per trader" you must (a) add a caveat here, or (b) change the hybrid to honour `config.initialCash`. |
| Pre-seeded inventory | CLOB only: 30% of traders seeded with 100 YES, 30% with 100 NO (`simulation.ts:457-473`). | Hybrid pre-seed uses a separate path; do not claim CLOB seeding semantics for hybrid. |
| Determinism scope | Intent list is deterministic; engine logic is deterministic; identifiers and log timestamps are not. | Use "deterministic execution with non-deterministic timestamp decoration" consistently. |
| Sell-to-close scope | YES-only at the CLOB engine layer. NO-side "sell" is implemented as BUY YES at the adapter. | Do not claim a NO-side sell-to-close constraint. |
| PriceLevel ordering | Price-time priority (price first, FIFO within level). | Consistent across Ch 4.4 and 5.3. |
| LMSR price bounds | Strictly (0,1) by sigmoid form; no clamp. | Keep; do not say "clamped to (0,1)". |
| Decimal config | Precision 28, ROUND_HALF_UP (`binaryLmsr.ts:14-19`). | If Ch 7 reports precision effects, cite this exact config. |
| Test count | 342 passing after the cleanup run (prior run log). | Re-run if the repo has changed before final submission. |
| Adapter LIMIT on LMSR | `intent.price` is **not** consulted on the LMSR path. | Do not present LMSR as "respecting limit prices". |
| Hybrid "SELL NO" edge case | Mis-disqualifies when trader holds NO but not YES (see §6 of §A). | Add a dedicated paragraph or treat as a known limitation. |

---

## C. Figure Captions — Fully Supported by Code?

(Captions 4.1–4.3 are not present in the pasted chapter text; only 4.4–4.8 have explicit captions to verify. 4.1–4.3 are framed as Figure references in prose but their captions were not included in the submission.)

| Figure | Caption claim | Fully supported by code? | Comments |
|--------|----------------|---------------------------|----------|
| 4.1 | "High-level architecture of the implemented simulator… no backend API layer or request-handling tier… common engine interface… CLOB and LMSR adapted… hybrid implements it directly." | **Yes** | No `route.ts` under `src/`; `UnifiedEngine` interface in `engine-common.ts`; adapters in `engine-adapters.ts`; `HybridRouterV2` implements `UnifiedEngine` directly. |
| 4.2 | "Shared domain model… OrderIntent → ExecutionResult… CLOB maintains internal trade record… each mechanism keeps its own internal trader-account structure." | **Partial** | All true, but caption should note that the CLOB's `noShares` field is carried but not used by CLOB matching. |
| 4.3 | (not present in the pasted caption list) | — | Not verifiable here. |
| 4.4 | "LMSR engine architecture and adapter bridge… log-sum-exp stabilisation… sigmoid form… quote-by-quantity differences two cost evaluations; quote-by-spend numerically inverts via bounded bisection… adapter rewrites SELL as BUY of opposite outcome; MARKET→spend, LIMIT→qty; ignores intent.price; slippage/priceImpact null… settlement is engine capability not invoked by SimulationRunner." | **Yes** | Every claim matches `binaryLmsr.ts:401-416, 89-90, 206-225` and `engine-adapters.ts:722-724, 753-765, 803-804`. SVG is `public/figure-4-4-lmsr.svg` — content matches. |
| 4.5 | "Hybrid controller routing in the live SPREAD_BASED mode… CLOB spread; YES inventory; min opposing-side depth across three price levels; unfilled buy remainder forwards to LMSR; sell orders never forward; controller maintains mutable ledgers and shared per-trader positions synchronised before and after each execution." | **Yes, with one caveat** | All verified in `hybrid-router-v2.ts:514-543, 462-471, 715-738`. SVG is `public/figure-4-5-hybrid.svg`; it also notes explicitly that "depthTicks is accepted, not consulted" and "routing uses fixed 3-level window" — consistent with code. Minor: SVG footer says "routing reads CLOB spread + depth and shared YES inventory (for SELL)" which is accurate; caption prose could adopt this phrasing. |
| 4.6 | "Workload generation pipeline… OrderIntentGenerator.generate() produces a fixed list… SimulationRunner.runSync replays the same list against each engine." | **Partial** | Pipeline is correct. **But:** the runner method is `run()` (async), not `runSync` — `simulation.ts:479`. Either rename the caption to `run()` or add a `runSync` alias. This is a literal name mismatch an examiner will see in the code browser. |
| 4.7 | "Metrics pipeline… SimulationRunner.runSync dispatches each OrderIntent… ExecutionResult and post-order MarketStateSnapshot… slippage/priceImpact populated for CLOB and hybrid but not LMSR; spread and top-of-book depth for CLOB and hybrid; explicit YES-price for LMSR and hybrid; absent quantities left absent rather than inferred." | **Partial** | Same `runSync` naming mismatch. Metric-specific claims verified (see Ch 4.8 rows). One substantive issue: "absent rather than inferred" — the `depthSeries` is zero-filled for LMSR, not absent. Replace "left absent rather than inferred" with "left absent or zero-filled, per metric". |
| 4.8 | "User-interface surfaces… /experiments dashboard… /clob-test playground… /lmsr-test playground… only the dashboard exercises the full simulator pipeline; the playgrounds interact with engines directly." | **Yes** | All three routes exist; playgrounds instantiate engines directly (not through `SimulationRunner`). |

---

## Consolidated list of code-level fixes to either implement or disclose

If you want the text to match the code exactly, pick one side of each of these. These are the only items where the current chapter text is factually unsafe (as opposed to merely loose).

1. **CLOB `noShares`.** Either (a) remove `noShares` from the `CLOBEngine.TraderAccount` type and all downstream bookkeeping, or (b) change the Ch 4.3.3 / Ch 5.3.2 wording to "NO-shares are carried for adapter-layer outcome conversion but not consulted by CLOB matching".
2. **`runSync` vs `run`.** Either add a `runSync` alias on `SimulationRunner`, or change Figure 4.6 and 4.7 captions to `run()`.
3. **Hybrid initial cash.** Either change `hybrid-router-v2.ts:243` to use the scenario `initialCash`, or disclose in Ch 5.5 that hybrid traders are initialised with a fixed 100,000 regardless of scenario config.
4. **`src/app/page.tsx` description.** Update Ch 5.2 to reflect that `/` redirects to `/experiments` (not "default framework scaffold").
5. **SHOCK "one-off" wording.** Either remove the `shockProbability` gate in `simulation.ts:402-408` so the jump is deterministic at `shockTime`, or change Ch 4.7.2 / Ch 5.6.2 wording to "triggered stochastically from the configured shock time".
6. **`SELL NO` routing bug.** Either (a) rewrite the controller's sell-eligibility predicate to understand adapter conversion (i.e. check `yesShares` for SELL YES and `noShares` for SELL NO, or perform adapter conversion before routing), or (b) document this as an explicit known limitation in Ch 5.5.3.
7. **LMSR `depthSeries` zero-fill.** Either have the LMSR adapter emit `bidDepth`/`askDepth` as `undefined` and guard in `simulation.ts:637-639`, or rewrite Ch 4.8.2 to say "zero-filled for LMSR" instead of "absent".
