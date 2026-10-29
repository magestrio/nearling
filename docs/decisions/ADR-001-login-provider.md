# ADR-001: Login provider — Google sign-in without wallet popups

**Status:** Accepted — Privy (OD-90, the user's decision 2026-10-27: «privy давай»; kept after the re-check: «ладно, сидим с privy»)
**Date:** 2026-10-27
**Deciders:** the user

## Context
The player signs in with Google and never sees a wallet (PRODUCT.md Positioning; wallet popups are Out of v1). The pet is minted by the server to the player's NEAR account id, so the provider must give an account id at sign-in. The player still signs some transactions himself: feeding with his own NEAR (`add-feeding`) and the gift, which needs a full-access signature with 1 yoctoNEAR (`near-contract` › For the spec). The playtest runs on mainnet on 2026-11-12…14 (§4). All facts below are from `.claude/skills/web-client` and `.claude/skills/near-contract/references/facts.md` §C, checked 2026-10-27.

## Options Considered

### Option A: Privy (React, `chainType: 'near'`)
| Dimension | Assessment |
|-----------|------------|
| Popups | Google modal at sign-in; then `signRawHash` "signed silently" — whether a confirmation modal can appear is unconfirmed |
| Cost | Free 0–499 MAU and 50K signatures/month; Core $299/month from 500 MAU (privy.io/pricing, published 2026-10-22, volatile) |
| Mainnet | yes |
| Keys | embedded wallet = NEAR implicit account (64 hex); keys held by Privy in TEEs; automatic recovery on a new device |
| Data | the Google identity goes to Privy |

**Pros:** no popup after sign-in, including the gift; mainnet without approval; free at playtest size.
**Re-checked 2026-10-27 (producer; volatile, re-check before the build):** docs.privy.io/wallets/overview/chains lists NEAR under Tier 2 — transaction-aware signing; no managed submission (Privy does not broadcast), no gas sponsorship, no smart wallets or batching (Tier 3 only). privy.io/pricing: Developer free 0–499 MAU, 50K signatures and $1M volume a month; Core $299/month for 500–2,499 MAU; MAU = "any Privy-authenticated user with at least one active session in the last 30 days". What happens to a free app above 499 MAU, and whether a card is needed, is not stated. On a cancelled subscription: "If your app has already reached 500 MAUs, new users will no longer be able to sign up".

**Cons:** NEAR is Privy Tier 2 (our app builds and broadcasts, no gas sponsorship — volatile); the implicit account does not exist until funded (0.007 NEAR); whether `signRawHash` can sign a NEP-366 DelegateAction is undocumented; "Google OAuth may not work in in-app browsers".

### Option B: NEAR Auth (successor of FastAuth)
| Dimension | Assessment |
|-----------|------------|
| Popups | an Auth0 popup or redirect on every signature |
| Cost | gas and the MPC sign deposit ("refunded in every branch"); no per-MAU price found |
| Mainnet | needs whitelisting through an application form; lead time unknown |
| Keys | derived by MPC at path `jwt#auth0#<sub>`; the app creates or funds the account |
| Data | the Google identity goes to Auth0 |

**Pros:** keys are not held by a single company; same key on any device from the same login; a relayer path exists (`signAndSendDelegateAction`).
**Cons:** a popup on every feed and on the gift; mainnet approval may not arrive before 2026-11-12.

### Option C: Web3Auth / MetaMask Embedded Wallets
| Dimension | Assessment |
|-----------|------------|
| Popups | OAuth login; signing popups not documented |
| Cost | unconfirmed |
| Mainnet | chain config listed; examples on testnet |
| Keys | the SDK returns the player's private key to our app |

**Pros:** no popup per signature.
**Cons:** our web app holds the private key in the browser; pricing and NEAR mainnet maturity unconfirmed.

### Rejected: NEAR Connect with a limited function-call key
Needs a real wallet and shows a wallet confirmation for every deposit — wallet popups are Out of v1.

## Trade-off Analysis
Privy is the only option with no popup after sign-in and no mainnet approval step; its cost is that key custody sits with Privy and gas must be solved by us (a separate decision raised with `add-feeding`). NEAR Auth gives better key custody at the price of a popup on every feed and a mainnet approval the schedule cannot wait for.

## Recommendation
Privy — the only option with no popups and mainnet without approval, free under 500 MAU. Volatile: Privy's NEAR tier and pricing.

## Decision
Privy (OD-90, the user, 2026-10-27).

## Consequences
- The pet is minted to the player's implicit account id; the account is created (0.007 NEAR, the project pays — §4) only when the player first signs a transaction.
- Privy signs and never broadcasts: every transaction the player signs goes out through our app; Privy pays no gas.
- The Google identity and the custody of the player's key sit with Privy; its retention period is not stated in our sources — "unknown" in PRODUCT.md §8.
- The playtest (≈ 150 signed-in people, PRODUCT.md §4) stays under 499 MAU; a viral day can cross it, and what Privy does to a free app above 499 MAU is not stated. The user's answers (OD-130, 2026-10-27: «закрой на 480»; round 2: a signed-in player is one signed in this calendar UTC month): the server counts players with a sign-in or a request with a session in this calendar UTC month and at 480 closes sign-in for new players (`add-account` › `Sign-in data`); Privy's own count is a session in the last 30 days, so at the start of a month Privy can count more than we do — in November only October's development sign-ins [estimate]. A signed-out guest's browser does not reach Privy before tapping an action, so the guest is not counted [hypothesis: Privy counts only authenticated users]. Privy authentication itself is the count, so before sign-in the server cannot tell a new player from a known one without a live session: while sign-in is closed, every visitor without a session is refused before Google and only one who taps «Played here before? Sign in» reaches Privy (OD-830, the user, 2026-10-28). A refused player who passed Google may already be counted by Privy, so the server counts such refusals too and at 490 closes sign-in for everyone without a session until the 1st (OD-840 → B, ADR-015; 490 rather than 499 leaves 9 spare to Privy's 500, OD-900 → B, ADR-016; the user, 2026-10-28). Development and testnet sign in to a separate Privy app (ADR-015 › Insurance). Privy has no sign-up switch but an allowlist that lets existing users in and new ones only if listed; whether it is on the Free plan and covers Google is not stated (research/gap-privy-signup-mau-logout.md, volatile). Logout clears the session "from the device"; other devices are not addressed (same source).
- Google sign-in in the X and Telegram in-app browsers needs the exit-to-browser path (`add-account`).
- Privy gets only the home address `/` as the return address; the place and the tapped action (a pet, a gift code, a receipt id) stay in the tab's session storage for the time of sign-in, so a gift code never reaches Privy (`add-account` › `Sign-in return data`; the user, 2026-10-28, Final critic QA BLOCKER 4 → «Место хранит вкладка»). Whether Privy accepts that return address is unconfirmed until the build.
- The player's key signs any hash (`signRawHash`): «no withdrawal» is a rule of our client, not of the key. A player running their own code in the browser can send their NEAR, and the gas the project topped up, out of the game (`add-feeding` › `Player wallet data`; the user, 2026-10-28, Final critic Attacker MINOR 5).
- Gas for the player's own transactions: an open decision with `add-feeding`.

## Action Items
1. [x] The user picks the provider (OD-90) — Privy, 2026-10-27.
2. [ ] Re-check Privy's NEAR tier and pricing before the build.
3. [ ] When Privy is set up at the build (the user, 2026-10-28): is the allowlist on the Free plan and does it apply to Google; is a user refused by our server counted in MAU; does logout end the session on other devices.
4. [ ] At the build, day 1: Privy's Google sign-in returns to `/` with the page address withheld from Privy (`Sign-in return data`).
