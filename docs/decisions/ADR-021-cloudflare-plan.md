# ADR-021: Which Cloudflare plan the server runs on for the playtest — Workers Free or Paid

**Status:** Accepted (OD-1210 → «Платный, $5/мес», user decision 2026-10-28)
**Date:** 2026-10-28
**Deciders:** the user

## Context
Everything the game keeps privately lives in one D1 behind the Worker: the pet's memory, sessions, the sign-in count, the ritual, the work records, and since OD-1200 the playtest events (ADR-019). Two facts in PRODUCT.md §8 depended on the plan without saying so: D1 Time Travel was written as 30 days, and Workers Logs as 7 days — both are Paid-plan numbers (`cf-worker` › Where content can land; volatile). The research found the Free numbers differ, and that the Free plan stops D1 outright at its daily cap [fact: research/gap-d1-playtest-events-cost.md and research/gap-cloudflare-workers-free-vs-paid.md, Cloudflare pricing, limits, Workers Logs, Time Travel and changelog pages, 2026-10-28; volatile]:

- Free: 100,000 rows written and 5 million rows read a day; past either, every D1 query fails until 00:00 UTC. The 2026-09-01 changelog states the enforcement per account. Requests: 100,000 a day; CPU 10 ms per request.
- Paid: "minimum charge of $5 USD per month for an account"; 10 million requests and 30 million CPU ms a month included; D1 — 50 million rows written and 25 billion read a month included, then $1.00 per million written; 5 GB storage; 20 million Workers Logs events a month; no daily stop.
- Time Travel: 7 days on Free, 30 on Paid, no extra charge.
- Workers Logs retention: 3 days on Free, 7 on Paid.

## Options Considered

### Option A: Workers Free
| Dimension | Assessment |
| --- | --- |
| Cost | $0 |
| What the player sees | nothing, until the account's writes in a day pass 100,000: then the whole game — conversation, memory, sign-in, the ritual — fails until 00:00 UTC (`add-pet` › `Connection rule` texts) |
| Retention | erased memory restorable 7 more days; Workers Logs 3 days |
| Load | the playtest events are ≈ 28,000 rows over 14 days [estimate: ADR-019]; the game's own writes a day are not estimated |
| Scenarios | +0; the Clear memory dialog says 7 days instead of 30 |

### Option B: Workers Paid
| Dimension | Assessment |
| --- | --- |
| Cost | $5 a month per account; D1 for the playtest stays inside the included amounts [fact: research/gap-d1-playtest-events-cost.md] |
| What the player sees | no daily stop of D1 |
| Retention | erased memory restorable 30 more days — longer than Free; Workers Logs 7 days (volatile) |
| Scenarios | +0; the Clear memory dialog keeps 30 days |

## Trade-off Analysis
A costs nothing and keeps an erased memory restorable for a shorter time, at the risk that one heavy day stops every part of the game until midnight UTC — on the three playtest days that is a lost day of data and of players. B removes that stop for $5 a month and keeps erased data restorable longer.

## Decision
B — Workers Paid, $5 a month (user decision 2026-10-28, OD-1210).

## Consequences
- §8 › Хранение and every `data` Requirement read 30 days for D1 Time Travel and 7 days for Workers Logs (volatile); §8 › Удаление, `Memory deletion data` and `Analytics delivery data` › «срок вышел» read «up to 30 days», and the Clear memory dialog says «Our backup keeps a copy for up to 30 days.» (the user, 2026-10-28: Paid for November only).
- The plan is a fixed project cost outside the $100 birth threshold's running sum; §4 › Траты проекта counts one month (November) in the $120 cap (product-lead). Whether the $5 is prorated for a partial month is not looked up.
- The account stays on Paid for November only: after the move to Free, Time Travel is 7 days, so an erased state is restorable for up to 30 days, not 30 (named once in §8 › Удаление).

## Action Items
1. [x] researcher: the Workers Paid monthly price; Workers Logs retention on Free; whether the Free D1 daily cap is per account or per database (research/gap-cloudflare-workers-free-vs-paid.md).
2. [x] The user picks A or B (OD-1210 → B).
3. [x] product-lead: §4 › Траты проекта — the $5 a month line.
4. [x] The dialog's period — «for up to 30 days», Paid for November only (the user, 2026-10-28); ux-architect changes the Clear memory dialog.
