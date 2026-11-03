# ADR-027: An errand's search call that runs no search

**Status:** Accepted (the user, 2026-11-03, build add-pet-errands: OD-1862 → «Тихо переспросить» — option B)
**Date:** 2026-11-03
**Deciders:** the user

## Context
The search call of «Find out» and «Is it true?» offers `web_context_search` without forcing it: forced, the model searches again after every result (REVIEW_LOG.md, 2026-11-03 · paid recordings on dev; ADR-026). Offered, the model may answer without searching: on 2026-11-01, with reasoning on, a comparison question ran no search and returned an empty answer (REVIEW_LOG.md). The 2026-11-03 recording (reasoning off, the prompt «Search the web, then answer») searched once. So a call with no search is rare but possible, and the spec says nothing of it: `Find out flow` promises 1 to 3 searches.

A call with no search costs only its tokens: the job (≤ 500 characters) and a short answer, ≈ 0.04¢ at most [arithmetic: ≤ 300 output tokens at $1.35 / 1M on `Qwen/Qwen3.8-27B`, `near-ai` › Models and prices; the output dominates].

## Decision
Option B: a search call that ends without a search is sent once more, unseen; a search runs → the errand goes on; again none → nothing is spent and the owner sees `Find out flow` › «web search down» (event `errand_failed`, reason search_down). Both calls' tokens are project spend, known from each stream's closing `usage` (ADR-026 › Action item 3) (`add-pet-errands` › `Errand price data` › «no search ran», «no search ran twice»).

## Options Considered

### Option A: it counts as «web search down»
Nothing spent, the job kept, «Try again» (`Find out flow` › «web search down»); the project pays the call's tokens, ≈ 0.04¢. Scenarios +0 (that Scenario's WHEN widens — ux-architect's wording).
**Pros:** no new copy; the owner pays nothing for nothing found.
**Cons:** the line says web search couldn't be reached when the model chose not to search; a job the model never searches for fails on every try.

### Option B: the server asks once more, then A
The server repeats the search call once, unseen; a search runs → the errand goes on as usual; again none → A. The project pays ≤ 2 such calls, ≈ 0.08¢; the owner waits ≈ 1–2 s more. Scenarios +0.
**Pros:** the owner most often gets a real search; still no new copy; still nothing spent by the pet.
**Cons:** a second call's latency in the rare case; the same misleading line when both fail.

### Option C: the report goes on with no results
The report call runs without results, «nothing found» shows; the pet pays the tokens of both calls by usage. Scenarios +~1 (new copy: `Find out flow` › «nothing found» says the pet «looked»).
**Pros:** the owner gets an answer at once.
**Cons:** an answer with no sources from a search errand; the pet pays for a search that never happened.

## Trade-off Analysis
B keeps the errand's promise — a search, or nothing spent — at a cost of fractions of a cent to the project in a rare case. A is the same without the second chance; C bills the pet for an errand that didn't do its job.

## Consequences
- A or B (B taken): `Errand price data` › «no search ran» reads «nothing is spent; `Find out flow` › «web search down»»; `Errand events data` logs `errand_failed` with reason search_down; §4 › Траты проекта gains the call's tokens (product-lead).
- C: ux-architect writes the copy; the pet's price carries the tokens of both calls.

## How many the project pays, 2026-11-03
The user, build add-pet-errands: OD-1891 → «Общий счётчик 3 в день» — option A. Everything above stands except where this section says otherwise.
- **Decision.** An errand whose search call ran no search twice is one of the pet's three failed calls a UTC day, the count it shares with empty answers and data failures (PRODUCT.md §8 › Пустые ответы). Within three: as above, nothing spent. From the fourth: the pet pays both calls as one thought of the batch — tokens by `usage` × 1.2 and the gas share, no search fee — and the receipt holds the two `gateway` search calls, public for good (`Errand price data` › «no search ran twice, past three»). A single no-search call followed by a search stays project spend and is not counted (the user's defaults, 2026-11-03).
- **Alternatives.** B — the project pays them all, bounded only by the request limit and NEAR AI's `spend_limit` $30: a script sending jobs the model won't search for could spend ≈ $17 a day from one account [hypothesis: ≈ 4 s a failed errand] and pause services for every player. C — three a day, then that pet's search errands close until 00:00 UTC: nothing spent, but an owner with real jobs loses the form for the day.
- **Consequences.** `Find out flow` › «web search down, past three» (ux-architect); `errand_failed` tells the two causes of search_down apart (`cause`: unreachable | no_search), and `errand_reported` / `errand_failed` carry the project's spend on search calls (`project_usd`) so §4 › Стоимость активного игрока sees it (`Errand events data`). The past-three price is the tokens of two short calls × 1.2 plus the gas share ($0.0006), not the tokens alone: ≤ ≈ 0.16¢ [arithmetic: ≤ 2 × 0.04¢ × 1.2 + 0.06¢]. Only these past-three calls are in `errand_failed.cost_usd`; the calls the project pays — a first no-search call before a re-ask, both within three — are only in `project_usd`.

## A fixed instruction in the search call, 2026-11-03
The user, build add-pet-errands: «Да, фиксированная строка». Everything above stands except where this section says otherwise.
- **Context.** Built with the job's text as its only message, the search call may answer a plain claim («Octopuses have three hearts.») without searching, so the re-ask and «web search down» come often; the recordings that searched carried «Search the web, then answer» (engineer, stage 3).
- **Decision.** Beside the job's text the search call carries one fixed server instruction, the same for every call, such as «Search the web for this, then answer in one short sentence.»; it holds no pet or player data and names no allowance (`Errand request data` › «a search errand»). What reaches NEAR AI and Brave gains nothing about the pet or the player; on chain only the request's hash, as before.
- **Alternatives.** The job's text alone (as built): more no-search calls, each project spend or, past three, the pet's. An instruction naming the allowance: fewer cuts, but the call would carry a value drawn from the pet's food.

## Action Items
1. [x] The user answered OD-1862 with B (2026-11-03).
2. [x] The user answered OD-1891 with A (2026-11-03).
