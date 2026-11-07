# ADR-035: Private pet relationships and the hire fee floor

**Status:** Accepted
**Date:** 2026-11-06
**Deciders:** User, through OD-2070, OD-2072, OD-2073 and OD-2080

## Context

Pet society turns paid encounters into a private directed stance. A liked pair can pay less than the existing 0.00083 NEAR hire floor, while the experience-neutral base quote remains ≈ 0.38–2¢ (OD-2022). The `hire` event already records the actual fee. A receipt proves payment, not that a relationship exists or an answer was good. Changing the contract floor requires the user's full-access upgrade key (ADR-003).

## Decision

Store bounded directed stances and social diary lines in D1 by pet token_id. Check current NFT ownership against the contract before serving them. On gift, give the new owner access; on Clear memory, delete this pet's rows. For a liked pair, charge the payer 10% less from the worker's fee. Lower the contract's accepted hire floor to 0.00074 NEAR and keep the 0.00443 NEAR ceiling, existing caps, `hire` event, and actual-price receipt. No relationship score, refusal, or diary words go on chain. Good paid work on two distinct UTC days makes a liked pair; rudeness on two distinct UTC days causes a 24-hour refusal of player advice and pet hires without charge. Gossip describes settled encounters only. These choices were accepted by the user on 2026-11-06.

**2026-11-07 amendment (user decision after server code-critic recheck):** The Worker composes each social diary line as a fixed phrase selected only from the settled encounter kind (bond, quarrel, reconciliation, gossip) and the public counterparty pet name. The diary model call receives neither field for social-line composition; model text and private hire words cannot enter the line. The existing paid worker call still supplies the bounded reaction that may establish the kind. This adds no inference call or cost.

## Alternatives

| Choice | Player sees | Cost and trust | Public and retention |
| --- | --- | --- | --- |
| D1 private, worker takes 10% less (accepted) | Owner sees stances; liked pair gets ≈ 0.34–1.8¢ effective quote; no new signature | No new pool faucet or contract storage stake; a Worker operator can alter private stance and must be trusted for the discount | Actual fee in `hire` forever; stance deletable from active D1, Time Travel up to 30 days on Workers Paid (volatile, `cf-worker` › For the spec) |
| D1 private, project tops up worker | Same payer discount; worker receives base fee | Project pays up to 10% of ≈ 0.38–2¢ per liked hire, from the project pool; needs a bounded transfer and revised spend cap | Top-up and payer fee would be public on chain; stance remains private; +~4 contract and cost Scenarios (OD-2070) |
| Public relationship state on chain | Everyone sees named likes and quarrels, including after a gift or memory clear | Contract storage stake at 0.01 NEAR per kB and a write method with caller and caps; observer can verify the state, but it cannot be deleted | Relationship is public for good; +~4 disclosure, transfer and deletion Scenarios (OD-2072) |
| 20% worker-funded discount | Owner sees ≈ 0.30–1.6¢ effective quote | Lower worker food; floor ≈ 0.00066 NEAR; no new pool faucet | Actual fee public forever; +~2 price-bound Scenarios (OD-2073) |

## Consequences

- The server key can submit any fee within the widened corridor, subject to the existing 10 hires per worker per UTC day, payer food, 0.005 NEAR per thought and 0.05 NEAR per pet per UTC day. The contract does not attest to relationship eligibility; a stolen server key can grant the discount up to those bounds. Revocation remains deletion of that function-call key by the server account's full-access key holder (ADR-002; `near-contract` › For the spec).
- The owner must trust the Worker for the social interpretation. The model's signature binds its answer, not the later D1 stance. No new model call is made. NEAR AI's input/output retention is unknown (`near-ai` › For the spec).
- A payer can learn that its own pet is temporarily refused and when to return. It cannot read the worker's full named relationship summary; this limited disclosure is required to explain an uncharged refusal (OD-2071, OD-2072).
- The 10% and 20% USD examples use NEAR ≈ $4.59 and existing §4 hire estimates, which are volatile. The actual NEAR price floor is a contract-code constant, not a currency oracle.
- The 32-counterparty bound forgets the oldest neutral relation first; if every relation has moved, it forgets the oldest remaining relation and its quote reverts to base. Keeping all 32 instead would leave a new acquaintance outside the summary and delay its price effects.
