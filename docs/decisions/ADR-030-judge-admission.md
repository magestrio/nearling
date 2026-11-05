# ADR-030: Private judge admission after ordinary entry closes

**Status:** Accepted — private codes, ten with two new Google identities each (user, 2026-11-04, OD-1932, OD-1942, OD-1952)
**Date:** 2026-11-04
**Deciders:** the user

## Context

Ordinary entry closes at 460 to reserve 20 places under the 480 admitted-player limit. Privy's 490 counted-sign-in hard ceiling still protects the 500-MAU price step (ADR-015, ADR-016; the MAU terms are volatile). A human judge needs two identities to wake and receive a pet. The public demo and proof must remain readable without sign-in. Codes are delivered privately, never in the public README.

## Options Considered

| Option | Player experience | Cost and data |
| --- | --- | --- |
| A. Ten private codes, two new Google identities each | A human judge enters a code, then Google; the code expires after November 18 | Up to 20 of the already budgeted admission places; code hashes and redemption identities in D1, Google identity at Privy; no new chain data |
| B. Public demo only | Everyone sees proof, nobody new can interact once ordinary entry closes | No new accounts or code data; interactive wake and gift path unavailable to a late judge |
| C. Public invitation link | One tap starts Google for anyone holding the link | Link can spread and consume the 20 reserved places before judges arrive; same account and Privy costs as A |

## Decision

A. The Worker stores only hashes of random ≥128-bit codes and admits at most two distinct new Privy identities per code, within 480 total admissions and 490 counted sign-ins. A check before Google reserves nothing; the return redeems atomically. Codes expire at 2026-11-19 00:00 UTC and code records are deleted at 2026-12-01 00:00 UTC. Existing players follow `Sign-in data` and consume no judge place.

## Consequences

- A concurrent return can lose the last place after Google; `Judge admission data` names the visible refusal.
- An attacker with a code can consume its two places, but cannot transfer a pet or spend pet food without the admitted account's key. A D1 leak exposes hashed codes and redemption ids, not plaintext codes; a leaked plaintext code permits only two admissions before expiry.
- Extra judge accounts may consume up to 20 starter balances if each hatches: 20 × 0.02093 NEAR = 0.4186 NEAR, ≈ $1.92 at §4's volatile $4.59/NEAR. Account creation for a no-NEAR recipient is charged only on the existing gift path (near-contract › What it costs; §4 › Траты проекта).
- Privy MAU pricing and the NEAR→USD rate need rechecking before mainnet; no new provider is selected.
