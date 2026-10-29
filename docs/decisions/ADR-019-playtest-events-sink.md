# ADR-019: Where the playtest events go — our own table in D1 or PostHog

**Status:** Accepted — Option A, our own table in D1 (the user, 2026-10-28, OD-1200: «Своя таблица в D1»)
**Date:** 2026-10-28
**Deciders:** the user

## Context
The playtest (days 12–14, 2026-11-12…14, mainnet, 20–50 players and their friends) answers the questions of PRODUCT.md §4 › Метрики: D1 return, replies per session, the share of feeders, the friend's funnel by link, hires, wardrobe, closed birth and sign-in, time to the first thought — each also by device and for the non-crypto cohort. The events and their properties are defined once in `add-analytics` › `Playtest events data`; they carry no words of the player or the pet, no email, no account id and no token_id, only an opaque id of the tab, the player and the pet (`Analytics delivery data`).

Every event reaches our Worker first: the browser sends its few events (page opens, a shared link, the Add NEAR sheet, the tap that starts sign-in) to the Worker, and the Worker logs the rest itself at the moment the server sees the outcome. The open question is where the Worker writes them. Volume: ≈ 100 players × ≈ 20 events a day × 14 days ≈ 28,000 events [estimate: arithmetic, §4 › Траты проекта counts ≈ 100 players].

The default stack has D1 and no analytics provider; a new provider is a new dependency, a new secret and a new recipient of player data in §8.

## Options Considered

### Option A: Our own table in D1
The Worker writes each event as a row in D1; the user reads the metrics with SQL queries (the build writes them once, ≈ 15 for §4 [estimate]).
| Dimension | Assessment |
| --- | --- |
| Cost | $0 on either Workers plan: ≈ 28,000 rows written (56,000 with one secondary index — writing an indexed column adds a row) against 100,000 a day on Free or 50 million a month included on Paid; ≈ 8–14 MB of storage inside the included 5 GB; a full scan of the table reads 28,000 rows per query [fact: research/gap-d1-playtest-events-cost.md, D1 pricing page 2026-10-28; volatile] |
| What leaves the browser | nothing new beyond our server |
| Who keeps it | us only; deleted with the whole table on 2026-12-01 00:00 UTC (after the results of 2026-11-18, `hackathon-near` › Facts); D1 Time Travel keeps a restorable state 30 more days on Workers Paid (volatile, research/gap-d1-playtest-events-cost.md; the plan — OD-1210 → Paid, ADR-021) |
| Effort | the queries and, if wanted, a page for the README numbers; no charts out of the box |
| Scenarios | +~1 (`Analytics delivery data` › deleted on the date) |

### Option B: PostHog Cloud EU, fed by the Worker
The Worker sends each event to PostHog's EU ingestion host; no PostHog script runs in the browser, so PostHog never sees a player's IP, cookies or page addresses — only what the Worker sends.
| Dimension | Assessment |
| --- | --- |
| Cost | $0: the free plan takes 1M events a month and stops ingestion at the cap [fact: posthog skill › Setup, checked 2026-09-29; volatile] |
| What leaves the browser | nothing new beyond our server; from the server — event names, opaque ids, properties, times to PostHog (EU, Frankfurt) |
| Who keeps it | PostHog: the plan's window — 1 year on the free plan, can't be shortened; deletion is asynchronous, events go in a weekly batch [fact: posthog skill › For the spec, checked 2026-09-29; volatile]. Deleting the project after the hackathon is the user's step |
| Effort | funnels, retention and breakdowns by cohort and device ready in PostHog; a project token as a Worker secret; region choice (EU recommended — client IP discarded by default there) |
| Scenarios | +~2 (`Analytics delivery data` › sent to PostHog; kept for the plan's window) |

## Trade-off Analysis
Both options take the same events from the same place — the Worker — so the player sees no difference and the browser sends the same thing. The difference is who else holds the playtest data and who builds the charts. A keeps it inside the stack: no new provider, no new secret, a deletion date we control, at the price of writing the queries. B hands the charts to PostHog, which helps the fix-between-days rhythm of the playtest, at the price of a new third party in §8 that keeps the events for its plan window and deletes asynchronously.

With ≈ 28,000 events and ≈ 15 metrics, the queries are a small part of the build [estimate]; the charts' value grows with players the playtest won't have.

## Recommendation
A — our own table in D1: the default stack covers it, nothing reaches a new third party, and the deletion date is ours. B is the better choice only if the user wants ready dashboards during days 12–14 more than one recipient fewer.

## Consequences
- A: §8 › Уходит из браузера gets no new recipient; the events have a fixed end, 2026-12-01; the README numbers come from the queries.
- B: §8 gets PostHog as a recipient with its retention; the Worker holds a PostHog token; the user deletes the PostHog project when the numbers are taken.
- Either way: no event carries content; `Analytics delivery data` is the rule.

## Action Items
1. [x] The user picks A or B (OD-1200) — A, 2026-10-28.
2. [x] researcher: D1 price for the extra rows — $0 on both plans (research/gap-d1-playtest-events-cost.md).
3. [ ] Build (`design.md`): the events table lives in its own D1 database, apart from the game's, so a flood of events can't fill the database that holds the pets' memory; events from the browser and from requests without a session are taken within a limit per tab and per IP per minute and per UTC day, the excess dropped silently (critic MAJOR 4 → the user, 2026-10-28): per tab ≤ 60 a minute and ≤ 1,000 a UTC day, per IP ≤ 600 and ≤ 10,000; no IP in events, the per-IP count kept until the end of the UTC day; flood requests still reach the Worker and are paid ($0.30 per million over the included 10 million a month), with no Cloudflare IP rule in front — a residual risk at the playtest's scale (the user accepted the defaults, 2026-10-28); the events table has no secondary index — a scan of ≈ 28,000 rows is cheap and every index doubles the writes; the server stops writing events and erases the table at 2026-12-01 00:00 UTC on its own schedule, not by a manual step; the ≈ 15 metric queries are written once. Dashboard and Wrangler queries count as billable reads.
4. [x] Whether the Free daily cap counts per account or per database — moot: OD-1210 → Paid (ADR-021).
