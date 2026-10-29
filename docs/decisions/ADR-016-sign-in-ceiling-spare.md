# ADR-016: A spare below Privy's 500 — the sign-in ceiling at 490

**Status:** Accepted (OD-900 → B, the user, 2026-10-28)
**Date:** 2026-10-28
**Deciders:** the user

## Context
Sign-in closes for everyone without a session at 499 signed-in players and refused-after-Google accounts this calendar UTC month (OD-840, ADR-015). Privy's Free plan ends at 499 MAU; Core is $299/month from 500; MAU is "any Privy-authenticated user with at least one active session in the last 30 days" (privy.io/pricing, 2026-10-22, volatile — research/gap-privy-signup-mau-logout.md › Q2). The project's spend cap is $120 (PRODUCT.md §4).

Our count stops new Google sign-ins at 499 but cannot stop the ones that already passed the check. Privy counts a player when Google returns; our server counts him a moment later. So Privy can reach 500 while we are at 499:
- sign-ins in progress when the count reaches 499 — each lands as `Sign-in flow` › «закрылся для всех после Google» and is already counted by Privy;
- a sign-in Privy completed but our server never received (the tab closed, the network dropped);
- development and testnet sign-ins, if Privy counts MAU across the team's apps rather than per app (ADR-015 › Insurance, unconfirmed).
The user asked for insurance and to bring any change of 499 back as a question (2026-10-28, «Страхуем»).

## Options Considered

### Option A: Keep 499
Insurance is the separate Privy app for development and testnet only (ADR-015 › Insurance). One sign-in from any source above moves the app to Core in a month that reaches 480 sign-ins and 19 refusals. +~0 Scenarios.

### Option B: Ceiling at 490
A spare of 9 below Privy's 500 for the three sources above. Sign-in closes for everyone after 480 sign-ins and 10 refusals instead of 19 [estimate: arithmetic]; a farm of 10 Google accounts instead of 19 can close sign-in for returning players with an expired session until the 1st (the risk the user accepted on 2026-10-28 stays, smaller). +~0 Scenarios: the number in `add-account` › `Sign-in data`, PRODUCT.md §8, ADR-015, and product-lead's §3–§4 lines.

### Option C: Keep 499, take the place before Google
The server reserves a place in the count when a visitor is let through to Google and frees it if the sign-in does not complete within a few minutes, so sign-ins in progress can never exceed 499. Closed-for-everyone can then reopen within the month as places free up; a reservation that expires after Privy authenticated is lost from our count, and taps without a Google account can hold places for minutes. +~3 Scenarios (reserved, freed, reopened).

## Trade-off Analysis
A costs nothing and covers only development sign-ins, and only if Privy counts per app. B bounds all three sources at once, with no new behavior, at the price of locking returning players out a little earlier in a viral month. C keeps 499 for players but adds visible reopening and a cheap way to hold sign-in closed, and still misses a sign-in our server never hears of.

## Recommendation
B — the only option whose bound holds whatever Privy counts and however many sign-ins run in parallel. 9 is a guess sized to a few parallel sign-ins and a few team accounts [estimate]; the playtest expects ≈ 100 sign-ins in November (§4), so the ceiling matters only on a viral day.

## Decision
B, «Потолок 490, запас 9» (the user, 2026-10-28). Sign-in closes for everyone without a session at 490 signed-in players and refused-after-Google accounts this calendar UTC month, until 00:00 UTC on the 1st; the 9 places up to Privy's 500 are kept for sign-ins Privy counted and our server did not. In a viral month this happens after 480 sign-ins and 10 refusals after Google instead of 19 [estimate: arithmetic]. The separate Privy app for development and testnet stays on top (ADR-015 › Insurance, accepted the same day).

## Consequences
- `add-account` › `Sign-in data` (text and «потолок») and PRODUCT.md §8 (Игрок, Отказ после Google, Уходит из браузера › Google-аккаунт) read 490; the closed-for-everyone copy does not name the number and stays.
- A farm of 10 Google accounts can close sign-in for returning players with an expired session until the 1st — the risk accepted with OD-840, now at 10 accounts instead of 19.
- None of A–C covers a month after a full month: Privy's 30-day window still holds last month's players with unexpired sessions, while our count restarts on the 1st. In November that window is empty (code starts 2026-11-01); after the hackathon the user decides (PRODUCT.md §3 › Out of v1).
- Re-check Privy's MAU definition and whether it counts per app at the build (volatile).
