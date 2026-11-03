# ADR-025: Where a skill's code runs

**Status:** Accepted (OD-1821 → «Cloudflare Dynamic Workers», option A, the user, 2026-11-03)
**Date:** 2026-11-03
**Deciders:** the user

## Context
A skill can carry code the pet runs, as agent skills do (the user, 2026-11-02). The user named Cloudflare Dynamic Workers in a rough description and then said it is not a pick: «мне просто нужно нормальное решение». Accepted defaults (2026-11-03) for any place: apart from the game's server, no game data or keys, time and request limits per run, outbound only to its own skill's data sources, code stored encrypted; the project pays for running it (§4 › Траты проекта: $0 extra at our volume is the expectation, the place is tech-architect's). The server stays on the Cloudflare Worker (the user, 2026-11-02: «скипаем privacy и TEE»).

Expected volume: 1,000–10,000 runs a month, ≈ 2 s wall and ≈ 50 ms CPU each [estimate: research/gap-skill-code-sandbox.md › 1]. A run sits inside a hire (the asker waits for the worker's answer) or an errand (≈ 16–22 s already, §4 › Задержка).

## Decision (OD-1821, the user, 2026-11-03)
**A. Cloudflare Dynamic Workers in the game's own account.**
- The code is one JavaScript module (≤ 32 KB) that declares its functions with parameter types under ADR-024's type rule. Saved encrypted in D1 with the skills key (ADR-023), decrypted only in the Worker's memory to load it and to send it to the current owner's Skill code sheet, where the owner reads and edits it like the instruction (the user, 2026-11-03); never to another browser or the model.
- Each run is an isolate from `env.LOADER.get("<token_id>:<sha256 of the code>", …)` with `globalOutbound: null` (no `fetch`, no `connect`) and no bindings except one door, written by us, that calls this skill's ticked data-source tools through the Worker's MCP client (ADR-024) — the type rule, the cut and the 60-second cache apply there too. No D1, no secret, no other pet's anything.
- Limits per run: ≤ 50 ms CPU and ≤ 6 calls through the door (`limits: { cpuMs, subRequests }`, exceeding throws at once), ≤ 5 s wall by the Worker's own timer, output cut at 16,000 characters. A run over a limit is the code's failure: `Skill code flow` › «limit hit», `Adapter call rule` › «data failed in …».

## Options Considered

### Option A: Cloudflare Dynamic Workers (recommended)
| Dimension | Assessment |
|---|---|
| Isolation | V8 isolate per run plus Cloudflare's second-layer sandbox and tenant cordoning, V8 patches within hours (vendor) |
| Egress | closed by `globalOutbound: null`; the only way out is our door |
| Cold start | "a few milliseconds" (vendor) |
| Cost | inside Workers Paid's included requests and CPU at our volume; $0.002 per unique Dynamic Worker a day past 1,000 a month — tens of codes × 14 days stays under [estimate: research › 1.1; the blog's beta waiver and the pricing page differ, volatile] |
| Status | open beta since 2026-03-24; billing on the pricing page since 2026-05-26 (volatile) |
| Third parties | none: the code stays in our Cloudflare account |

**Pros:** no added wait in a hire; no new account, secret or bill; the "outbound only to its data sources" default holds by construction, not by a domain filter.
**Cons:** beta; the same class of runtime as the game's Worker: Check Point (Black Hat 2026) showed workerd memory bugs, one a cross-heap read and one a Code Mode escape on self-hosted workerd, rated Critical and fixed on managed Workers (research › 2). An unfixed bug of that class could reach what the game's Worker holds in memory.

### Option B: Cloudflare Sandbox (Containers)
| Dimension | Assessment |
|---|---|
| Isolation | a microVM per instance with its own kernel and network |
| Egress | `enableInternet: false`; an allowlist syntax not read (research › 1.3) |
| Cold start | not stated; containers boot in "hundreds of milliseconds" (Cloudflare's own blog) |
| Cost | inside Workers Paid's included 25 GiB-h at our volume [estimate: research › 1.3]; each container also bills a Durable Object |
| Status | GA 2026-04-13 |

**Pros:** a stronger wall than an isolate; any language.
**Cons:** an image to build and a Durable Object per container; a longer start inside a hire's wait; per-run CPU and wall caps not stated, so the Worker enforces them from outside.

### Option C: E2B
| Dimension | Assessment |
|---|---|
| Isolation | Firecracker microVM, own kernel |
| Egress | `allowOut` / `denyOut` by domain (SNI/Host only; DNS to 8.8.8.8 allowed) |
| Cold start | ≈ 150 ms (secondary) |
| Cost | ≈ $0.92 for 10,000 runs; Hobby has a one-time $100 credit [estimate: research › 1.6] |
| Status | GA |

**Pros:** the code never runs on the game's infrastructure; a microVM wall.
**Cons:** a third party gets every owner's code and test values (a new row in §8 › Уходит из браузера, +~1 Scenario); a new API key as a Worker secret whose theft spends our E2B balance; a network hop each run; a domain filter, not a closed door.

### Rejected without an OD
- **QuickJS compiled to wasm inside the game's Worker** ($0, no network by default): runs inside the game's server, against the accepted default «apart from the game's server»; the library is unaudited and QuickJS has 2025–2026 memory-safety CVEs (research › 1.4, 2).
- **Workers for Platforms**: $25 a month for what A does inside Workers Paid (research › 1.2).
- **Vercel Sandbox**: ≈ $7 at a one-minute minimum per run on Pro, a second cloud (research › 1.7).
- **Deno Sandbox**: pre-release, not in the free plan (research › 1.5). **Fly Machines**: isolation, limits and egress filtering not read (research › 1.8).

## Trade-off Analysis
A wins on wait, cost and the closed door; B and C win on the wall between owner code and the game's runtime. The accepted defaults already strip what an escape would find in the code's own isolate (no bindings, no secrets, no D1), so the residual risk under A is a runtime bug reaching a neighbouring isolate — the class Cloudflare patches on managed Workers within hours and the one Check Point found and Cloudflare fixed. With an owner's code reaching only typed calls to keyless sources, and both its CPU and its calls capped, A is the proportionate wall for a prototype. B is the step if the user wants a kernel boundary at the cost of a slower hire.

## Consequences
- Easier: no new account, key or invoice; runs add no visible wait.
- Harder: Dynamic Workers' beta terms can change (volatile); re-read pricing before R1.
- §8 › Ключи: the skills key now also opens code and data-source addresses; code adds no key.
- Cloudflare's retention of a loaded module is unstated: §8 › Хранение says "unknown" — for `load` and `get` alike, so caching by id costs no privacy we had.
- Billing (amended 2026-11-03, tech-architect, research/gap-dynamic-workers-billing.md): the pricing page bills «No ID provided or `.load(code)` used» as 1 Dynamic Worker per invocation, «Same code, same ID» as 1, «Same ID, different code versions» as 1 per version; the beta waiver is gone since 2026-05-26 (volatile). So runs use `get("<token_id>:<code hash>")`, not `load`: the bill is per pet and code version a UTC day, $0.002 each past 1,000 a month. Bound: ≤ 20 test runs a pet a UTC day (`Skill code data`) give ≤ 20 versions — a test of an undeclared function loads the module to read its declaration, so it uses one of the 20 too (`Skill code data` › «an undeclared function», the user, 2026-11-03, «Считать в 20») — plus 1 for the saved code's jobs, whose undeclared calls load nothing (the declaration kept at save) → ≤ 21 a code pet a day ≈ $0.042; N code pets ≈ $0.042 × N a day. Unknown: whether an isolate restart under the same id re-counts within a day — a build check with GraphQL `distinctDynamicWorkerCount` — and whether Cloudflare's day is the UTC day. No hard spend cap at Cloudflare; budget alerts email a day late.
- Game-wide ceiling (OD-1850 → «Общий предел», the user, 2026-11-03): the server counts distinct `<token_id>:<code hash>` loaded a UTC day, ≤ 330 across the game; a run that would load a new one past it doesn't load, and the code answers like a busy data source until 00:00 UTC, while a version already loaded that day still runs, since it bills nothing more. Bound: ≤ 330 × 30–31 − 1,000 ≈ 8,900–9,230 billed a month ≈ $17.8–18.5 (volatile price). The server counts every new version at $0.002 from the first (the user, 2026-11-03), including Cloudflare's first 1,000 in the month, in §8 › Траты проекта toward the $100 birth threshold (`Skill code data`).
- Owner code runs from the game's account: its calls through the door leave from Cloudflare's addresses, like the Worker's own.

## Action Items
1. [x] The user answered OD-1821 with A (2026-11-03).
2. [ ] Before R1: re-read Dynamic Workers' pricing and status (volatile) and the Workers Paid plan.
3. [ ] The build proves a run with `globalOutbound: null` can't `fetch`, and that `cpuMs` and `subRequests` throw at their caps (`Skill code flow` › «limit hit», «code error»).
4. [ ] The build reads `distinctDynamicWorkerCount` after 20 runs of one id and code in a day: 1 confirms the bound above; and across 00:00 UTC, to see whether Cloudflare's day is the one the game-wide count resets on.
