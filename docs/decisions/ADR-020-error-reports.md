# ADR-020: Error reports from the browser

**Status:** Accepted — Option B, a short code to our server (the user, 2026-10-28, OD-1201: «Короткий код на наш сервер»)
**Date:** 2026-10-28
**Deciders:** the user

## Context
The server's own errors already land as codes and counters in Workers Logs, 7 days (volatile), with no player id and no content — Cloudflare adds the request address to each line by itself (PRODUCT.md §8 › Хранение; `cf-worker` › Decided by default). What the server never sees are the failures that happen only in the browser: no WebGL or a lost WebGL context on a phone (`add-pet` › Pet screen), Google sign-in failing in an in-app browser (`add-account` › `Sign-in flow` › «вход не удался», «Google не пускает»), the server unreachable from the player's network (`add-pet` › `Connection rule`). Each has its own text for the player. The playtest is three days on phones and desktops (§4), and fixing between days needs to know which of these players hit [fact: game-design › Playtest — RITE].

Whether an error reporter is used, and what it may collect, is an open decision (`cf-worker` › Open decisions).

## Options Considered

### Option A: None
The browser sends no error reports. Server errors stay codes in Workers Logs. Browser-only failures are seen only when a playtester tells us. +0 Scenarios.

### Option B: Error codes as one more event, in the same place as the playtest events
The browser sends `app_error` with `code` from a closed list — one code per error text the player sees — and `device`, `in_app`, to our server, which writes it where the playtest events go (OD-1200). No message text, no stack with page data, no address. No new provider. +~2 Scenarios.

### Option C: Sentry
A third-party SDK in the browser and the Worker with stack traces. Some SDK defaults collect request bodies, headers and IP (`cf-worker` › Where content can land) — each has to be turned off for the "no content" rule. Price and retention: `? [gap]` — not in the knowledge skills or `research/`. +~3 Scenarios (the recipient, what is scrubbed, retention).

## Trade-off Analysis
A costs nothing and leaves the phone failures invisible during the very days they matter. B sees them as counts by device and in-app browser, with no new recipient and nothing that can carry the player's words — but without stack traces, so the build still reproduces each failure itself. C gives stack traces at the price of a new third party whose defaults collect more than the spec allows and whose terms aren't known here.

## Recommendation
B — the failures that only phones and in-app browsers produce become countable on day 12, with no new provider and the same no-content rule as the events.

## Consequences
- B: `add-analytics` › `Error report data` gets the `app_error` Scenario; the code list lives with the error texts in the build's `design.md`.
- A: `Error report data` keeps only the server-log rule.
- C: a new §8 recipient, an SDK scrubbing setup, and a research gap on price and retention.

## Action Items
1. [x] The user picks A, B or C (OD-1201) — B, 2026-10-28. The events table is our own D1 table (ADR-019), so `app_error` lives and is erased with the events on 2026-12-01.
2. [x] If C: researcher — not needed; research/gap-sentry-browser-error-reports.md stays for the record.
3. [ ] Applied in `add-analytics` › `Error report data`: «ошибка в браузере», «сервер недоступен» — the code of an unreachable server waits in tab memory and goes once the server answers; a closed tab loses it. The code list lives with the error texts in the build's `design.md`.
4. [ ] Build: the code writes no player id into log lines. Workers Logs keep, for 7 days, the request address Cloudflare attaches to every line (`$metadata.url`) — with a token_id or a gift code when the address carries one; `invocation_logs = false` drops only the separate invocation record with headers and IP location, and no documented switch strips the address from the code's lines (research/gap-cloudflare-workers-logs-invocation-metadata.md, unconfirmed by a real record). Checked on the first deploy by opening one line in Workers › Observability (volatile). Critic MINOR 5 → the user, 2026-10-28: «Логи остаются, честно в §8».
