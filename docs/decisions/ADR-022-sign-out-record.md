# ADR-022: Sign-out on the server — what the server keeps to end a session

**Status:** Accepted (`add-account › Sign-out data`, plan hole → «Хранить 24 часа», user decision 2026-10-30)
**Date:** 2026-10-30
**Deciders:** the user

## Context
A valid Privy token opens the server's API; the server keeps no session of its own (add-pet rejected a cookie session). Privy's docs describe no server-side revocation and do not say whether a backend can detect a logout; an access token lives 1 hour by default [fact: research/gap-privy-signup-mau-logout.md Q3, volatile], an identity token about an hour (`cf-worker` › For the build). So after «Sign out» the old token still opens the API until it expires, unless the server records that the session ended.

## Options Considered

### Option A: keep Privy's session id for 24 hours
| Dimension | Assessment |
| --- | --- |
| What the player sees | the session ends at once in every tab of this browser; other devices are untouched |
| Stored | the opaque `sid` and the time of the sign-out in D1, 24 hours; no player id, email or name |
| Cost | one more read on each request with a session, inside ADR-021's D1 allowance |

### Option B: keep nothing
| Dimension | Assessment |
| --- | --- |
| What the player sees | a second tab of this browser goes on working until its token expires (about an hour) |
| Stored | nothing |
| Cost | none |

### Option C: keep the token's hash
| Dimension | Assessment |
| --- | --- |
| What the player sees | the token of the tab that signed out ends at once; a tab holding another token ends at its expiry |
| Stored | a hash, same table, same period |
| Cost | as A |

## Trade-off Analysis
A stores one opaque id for a day and ends the session the way `Sign-out data` says. B stores nothing and leaves a session open after the player was told they are out. C holds no Privy id, at the price of the second tab.

## Decision
A (the user, 2026-10-30). C is the fallback only if a real identity token turns out not to carry `sid`.

## Consequences
- §8 › Сущности and Хранение gain Ended sign-in session; `Sign-out data` states the rule.
- Each request with a session reads the record; a sign-out that never reaches the server keeps no record, and the old token lives until it expires (`Sign-out data` › «server not reached»).
- A record refuses only the ended session, so signing in again depends on Privy giving a new id (`Sign-out data` › «signed in again»).
- 24 hours is the user's period, well above a token's life of about an hour (volatile).
- A request that fails at Privy still ends the session in the browser: Privy 3.51.0's `_destroy` catches the failure and runs `destroyLocalState`, which clears the refresh, access and identity tokens [fact: read in `web/node_modules/@privy-io/react-auth/dist/esm/toViemAccount-BQS52mmk.mjs`, not run; volatile]. So neither a sign-out that reached only the server nor one that reached neither brings the session back on reload. Whether Privy's own record of that refresh token stays valid is unknown; the browser no longer holds it. The spec relies on this (the user, 2026-10-30: «Полагаемся на Privy», `Sign-out data`).

## Action Items
1. [ ] At the build, on dev: a real identity token carries `sid`; if not, Option C and a §8 edit.
2. [ ] At the build, on dev: a new sign-in after a sign-out gets a new `sid`.
3. [ ] At the build, on dev, by hand: a sign-out with no network, then a reload with the network back, finds no session. If it finds one, the question goes back to the user.
