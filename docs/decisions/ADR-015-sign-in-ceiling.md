# ADR-015: Keeping Privy below its paid plan after sign-in closes

**Status:** Accepted (OD-840 → B, the user, 2026-10-28)
**Date:** 2026-10-28 (revised 2026-10-28 after research/gap-privy-signup-mau-logout.md)
**Deciders:** the user

## Context
Sign-in closes for new players at 480 signed-in players this calendar UTC month (OD-130). While it is closed, every visitor without a session is refused before Google, and only one who taps «Played here before? Sign in» reaches Privy (OD-830). The server can tell a new player from a returning one only after Privy authentication.

Privy counts MAU as "any Privy-authenticated user with at least one active session in the last 30 days" (privy.io/pricing, 2026-10-22, volatile — ADR-001). Read literally, a player we refuse after Google is already counted; Privy's docs do not address this case [unconfirmed]. Free is 0–499 MAU; Core is $299/month from 500 (same source); the project's spend cap is $120 (PRODUCT.md §4). There is no MAU counter in Privy's API; the dashboard notifies near the limit (research/gap-privy-signup-mau-logout.md › Q2).

Privy has no "close registration" switch, but it has an allowlist (research/gap-privy-signup-mau-logout.md › Q1, docs.privy.io/guide/guides/allowlist):
- turned on in the dashboard, Users › Access Control; the API manages entries (POST / DELETE / GET `/api/v1/apps/<app-id>/allowlist`) and the refusal screen (`allowlist_config`: title, detail, button text, button link); a toggle in the API is not described;
- "All existing users will still be permitted to login"; a new user only if their email, phone or wallet is listed;
- coverage "email, SMS, wallet, and OAuth methods with verified emails only" — Google is not named [unconfirmed];
- the plan it is on is not stated [unconfirmed];
- a user refused by the allowlist never authenticates, so by the same MAU definition has no session — the docs do not state it [unconfirmed].

The user chose to verify the three unconfirmed points when Privy is set up at the build (User Decisions, 2026-10-28).

## Options Considered

### Option A: No ceiling
Refused players after Google spend the buffer of 20 between 480 and 500. The 21st in a month moves the app to Core, $299/month. +~0 Scenarios.

### Option B: A ceiling at 499
The server also counts accounts refused after Google this month, and at 499 closes sign-in for every visitor without a session — returning players too — until 00:00 UTC on the 1st. The paid plan can't be reached by any number of stray taps, whatever Privy turns out to count. A returning player whose session expired is locked out only after 480 sign-ins and 19 refusals in one month [estimate]. +~2 Scenarios (`Sign-in data`, and the closed-for-all copy in `Sign-in flow`).

### Option C: Privy's allowlist from 480
At 480 the user turns the allowlist on in the Privy dashboard; on the 1st, off. A new Google account that taps «Played here before? Sign in» is refused by Privy itself after Google, on Privy's screen with our text, and gets no session. Players Privy already knows — from any earlier month — pass Privy, and our server refuses those not seen this month, as now; in November these are only October's development sign-ins. Between the 480th sign-in and the toggle, refusals after Google still spend the buffer; if the toggle is not turned off on the 1st, new players stay locked out in the new month. +~2 Scenarios (`Sign-in data`: on at 480, off on the 1st; `Sign-in flow`: Privy's refusal screen) and two manual steps per closed month.

## Trade-off Analysis
A keeps every returning player able to sign in, at an uncapped risk of $299/month. B holds the spend cap under every answer to the three unconfirmed Privy questions and needs no manual step, at the price of locking out a returning player with an expired session on a viral month; Privy's refresh session lasts 30 days (volatile), so most returning players never sign in again within the month. C locks out no returning player, but rests on all three unconfirmed points (allowlist on Free, Google covered, a refused user not counted), on the user acting at 480 and on the 1st, and shows a Privy screen instead of ours.

## Recommendation
B — the only option whose bound does not depend on unconfirmed Privy behavior; the playtest expects ≈ 100 sign-ins in November (§4), so the ceiling matters only on a viral day. If the build-time check confirms all three allowlist points, C can be added on top of B without undoing it.

## Decision
B, «Жёсткий потолок на 499» (the user, 2026-10-28); the number became 490 with OD-900 (ADR-016). The server counts each account refused after Google once a month, next to the players signed in this month; at 490 together, sign-in is closed for every visitor without a session, returning players too, until 00:00 UTC on the 1st, and players with a live session keep playing (`add-account` › `Sign-in data` › «потолок»). C may go on top of B if the build-time check confirms all three allowlist points; nothing in B is undone by it.

## Consequences
- The server keeps, per refused account, its Privy id and the month, until 00:00 UTC on the 1st (PRODUCT.md §8 › Отказ после Google) — nothing on chain, nothing leaves the browser beyond the Google sign-in itself.
- A player whose session expired cannot sign in again after the ceiling until the 1st; the copy of that refusal is a `Sign-in flow` Scenario (ux-architect).
- If C is added: the refusal text set in `allowlist_config` goes to Privy; the Google identity of a refused new player reaches Privy and not our server.
- Re-check Privy's MAU definition, pricing and the allowlist at the build (volatile).

## Insurance (the user, 2026-10-28: «Страхуем», after product-lead's Pushback)
At 499 the spare to Privy's 500 is one sign-in, while two earlier decisions rested on a spare of 20 (counter lag; the calendar month against Privy's 30 days).
- Applied (tech default, accepted by the user 2026-10-28, «Принимаю»): the mainnet build has its own Privy app; development and the testnet build sign in to a separate Privy app. Each environment has its own D1 (`cf-worker` › Setup), so a testnet sign-in in the mainnet app would count at Privy and never in the mainnet D1. Code starts 2026-11-01 (the user's repo rule), so the mainnet app carries no October sessions into November's 30-day window. Unconfirmed: whether Privy counts MAU per app or across the team's apps, and whether the Free plan allows two apps — a research gap; if MAU is counted across apps, the separate app insures nothing and the spare of 9 below has to cover development sign-ins too.
- Not covered by it, so covered by a spare: a Google sign-in already in progress when the count reaches the ceiling (Privy authenticates before our server sees it) and a sign-in Privy completed that never reached our server. The ceiling is 490, 9 below Privy's 500 (OD-900 → B, the user, 2026-10-28; ADR-016).
