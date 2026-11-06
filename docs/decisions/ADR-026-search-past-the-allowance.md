# ADR-026: An errand's search past the pet's allowance — cut the stream or let it finish

**Status:** Accepted (the user, 2026-11-03, build add-pet-errands: OD-1861 → «Обрывать» — option A)
**Date:** 2026-11-03
**Deciders:** the user
**Amended:** 2026-11-04 — the allowance of 2 holds only for a pet whose skill has data sources (reading a source takes the third search's place); a pet with code alone keeps 3, and the sheet shows a data-source pet its real ceiling, «up to ≈ 1.75¢» (`add-pet-errands` › `Errand sheet screen` › «a skill with outside data»).

## Context
A «Find out» or «Is it true?» errand runs one streamed NEAR AI call with the server-side tool `web_context_search`; NEAR AI runs the searches inside that call, and the model decides how many (OD-1760: up to 3; 2 for a pet whose skill has data sources — code alone keeps 3, amended 2026-11-04; fewer when food pays fewer — `add-pet-errands` › `Errand price data`). NEAR AI documents no cap on searches in a call: forced, the model ran 5 in one call (REVIEW_LOG.md, 2026-11-01).

Recorded on `dev` 2026-11-03 (the user's yes; REVIEW_LOG.md, 2026-11-03 · paid recordings on dev):
- With `tool_choice: "auto"` and `enable_thinking: false`, each search shows in the stream — its tool-call id and its query — about 2 s before its result arrives. So the server sees a search past the allowance before it runs.
- With `tool_choice: "required"` the model searches again after every result, forever; so the call is never forced (`Errand request data`: «offered but never forced») — the count stays the model's, as OD-1760 says.
- A stream the server aborts gets no signature (`null`); a finished one gets a `gateway` signature over `<sha256(req)>:<sha256(res)>`, which never proves that the model produced the bytes (`near-ai` › Signatures).
- `usage` is null in every chunk without `stream_options`. With `stream_options: {"include_usage": true}` a finished stream gets one more last chunk (`choices: []`) whose `usage` covers the whole call — both rounds, the injected search results inside `prompt_tokens` (recorded: 7,937 in, 45 out, 320 cached, one search) — and no field counts searches: the server counts them by distinct tool-call ids in the stream (REVIEW_LOG.md, 2026-11-03; the user's yes, one more paid call). An aborted stream has no final chunk, so a cut call has no `usage` at all.
- Not proven: whether aborting at a search's query stops NEAR AI from running and billing that search [hypothesis]. NEAR AI's Usage Reporting API would show it, but it needs a reporting token made with the user's dashboard login.

The pet pays at most its allowance in either option: the server prices the errand from the searches it counted, never past the «up to» shown. What differs is the project's spend, the search call's signature on chain, and the wait.

## Decision
Option A: the server cuts the search call at the query of a search past the allowance. The pet pays the searches within the allowance × 1.2, the report by usage and the gas share; the cut call goes into the receipt unsigned, with no tokens, marked cut, public for good; its tokens and the cut search's fee, if NEAR AI bills it [hypothesis], are project spend (`add-pet-errands` › `Errand price data` › «a search past the allowance»).

## Options Considered

### Option A: cut the search call at that search's query
| Dimension | Assessment |
|---|---|
| Pet pays | the searches within the allowance × 1.2, the report by usage, the gas share |
| Project pays | the cut search's fee if NEAR AI bills it (unproven): ≤ $0.005 a search (`SEARCH_USD_PER_CALL`, volatile, add-pet-errands design.md › Config); the cut call's own tokens, which come without `usage`: ≈ 0.02–0.08¢ [arithmetic: ≈ 6,000 input tokens a search round (REVIEW_LOG.md, 2026-11-01: 31,390 in for 5 searches) at $0.04 / 1M, `near-ai` › Models and prices] |
| Public on chain | the search call in the receipt with its request hash and the hash of the bytes received, no signature, no tokens, `cut` true |
| The owner waits | nothing extra: the report starts at once |
| Scenarios | +~1 (`add-verification` › Verification flow: a cut, unsigned «Web search» call) |

**Pros:** the project's spend is bounded at one search a cut errand; the report is never late for searches nobody pays.
**Cons:** that receipt's search call carries no signature; billing of a cut search unproven.

### Option B: let the search call finish
| Dimension | Assessment |
|---|---|
| Pet pays | as A, plus the search call's tokens by its closing `usage` (`stream_options.include_usage`, recorded 2026-11-03) |
| Project pays | every search past the allowance: $0.005 (volatile) and ≈ 0.024¢ of tokens each [arithmetic as above]; no cap but the model's own (5 seen) |
| Public on chain | the search call with its `gateway` signature |
| The owner waits | ≈ 2–3 s more a search (recording: result ≈ 2 s after the query) |
| Scenarios | +0 |

**Pros:** every search call in a receipt is signed; nothing new on Verification screen.
**Cons:** project spend left to the model; a loop like the forced one costs the project ≈ 0.5¢ a search until the server's 3-minute timeout; results the pet didn't pay for are thrown away.

## Trade-off Analysis
The pet pays the same either way. A trades a `gateway` signature on one call — a signature that proves only that the bytes passed NEAR AI's gateway, not that the model wrote them — for a hard bound on the project's spend and no wait. The report call, the one that is model-signed (`provider_tee`), is untouched in both. B keeps the receipt uniform at the price of an open-ended spend the server can't stop without becoming A.

## Consequences
- A (taken): `add-pet-errands` › `Errand price data` › «a search past the allowance» reads «the server cuts the call there»; §8 › Чек мысли and Траты проекта name the cut call; Verification screen shows a cut, unsigned search call (ux-architect); §4 › Траты проекта counts ≤ 1 search fee a cut errand (product-lead).
- B: the Scenario reads «lets it finish; the extra searches are project spend»; §4 › Траты проекта counts each extra search.
- Either: the search call's only instruction is one fixed server line, the same for every pet, that names no allowance (ADR-027 › A fixed instruction in the search call); the cut alone bounds the searches.

## Action Items
1. [x] The user answered OD-1861 with A (2026-11-03).
2. [ ] Read NEAR AI's billing for the aborted forced recording's request id: was the search running when the stream was cut billed? Still unproven: NEAR AI's Usage Reporting API needs a reporting token made with the user's dashboard login; until then the cut search's fee stays a [hypothesis] in §8 › Траты проекта (no new paid call needed).
3. [x] The build records whether `stream_options: {"include_usage": true}` adds `usage` to the search stream's last chunk and whether it counts the searches' tokens (a paid call: the user's yes). Recorded 2026-11-03 on `dev`: one extra last chunk, `choices: []`, `usage` of the whole call — both rounds, the injected results inside `prompt_tokens` (7,937 in, 45 out, 320 cached); no field counts searches — count them by distinct tool-call ids (REVIEW_LOG.md, 2026-11-03). `Errand price data` prices the search call's tokens by it.
