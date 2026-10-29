# ADR-014: The gift — how a pet moves to a new owner

**Status:** Accepted (OD-670 → A, the user, 2026-10-28: «Ссылка, друг принимает»)
**Date:** 2026-10-28
**Deciders:** the user

## Context
The gift is skeleton flow 6: the pet goes to a friend whole, and a gift is the only way a pet changes hands — no sale, no marketplace approvals (PRODUCT.md §3 › Out of v1; the user, 2026-10-27, critic MAJOR 7b). Facts (`near-contract`, checked 2026-10-27, volatile where marked):
- NEP-171 `nft_transfer` requires exactly 1 yoctoNEAR, so the owner signs with a deposit-capable (full-access) key — never the server's function-call key. [one_yocto](https://docs.near.org/smart-contracts/security/one_yocto)
- In `near-contract-standards`, `nft_transfer` takes only the 1 yocto; storage growth on transfer (the new owner's enumeration set) is paid from the contract balance — a known storage-attack vector. [core_impl.rs](https://github.com/near/near-sdk-rs/blob/master/near-contract-standards/src/non_fungible_token/core/core_impl.rs), [storage attacks](https://docs.near.org/smart-contracts/security/storage)
- Privy holds the players' keys and signs a raw hash without a prompt after login ("signed silently"; whether a modal can appear is unconfirmed); NEAR is Privy Tier 2: no broadcast, no gas sponsorship (volatile; ADR-001).
- A Privy wallet is an implicit account that does not exist on chain until the first transfer into it; account creation costs 0.007 NEAR, paid by the sender (nearcore 2.13, volatile). A pet minted to a player who never fed in NEAR belongs to an account that does not exist yet — that player cannot sign anything until it is created.
- A relayer (NEP-366) needs the sender's account to exist, and pays every attached deposit — it cannot create the giver's account. The server key cannot send NEAR (ADR-002). The project's gas account (ADR-006) can.
- The user's accepted default: the project pays players' account creation and gas (User Decisions, Product defaults).

## Options Considered — who picks the receiver (OD-670)

### Option A: a gift link the friend accepts, the giver transfers to the name they see
| Dimension | Assessment |
|-----------|------------|
| Contract | standard `nft_transfer` by the owner; no new method |
| The friend | needs neither an address nor NEAR; signs nothing |
| A leaked link | a stranger can accept, but the pet moves only on the giver's tap after they see the accepter's name |
| Stolen server key | moves no pet |
| Hacked server | can swap the accepted account together with the name it shows; the giver's browser checks the transfer against what the server shows, so it cannot catch this |
| Scenarios | +~0 (written) |

### Option B: the giver pastes the friend's game address and transfers at once
| Dimension | Assessment |
|-----------|------------|
| Contract | standard `nft_transfer` |
| The friend | has to sign in first and copy an address from Add NEAR sheet |
| Hacked server | cannot redirect: the browser checks the receiver against the pasted address |
| Scenarios | −~6 +~3 |

### Option C: the giver hands the pet to the contract; the first to accept gets it
| Dimension | Assessment |
|-----------|------------|
| Contract | a new escrow method and state |
| A leaked link | the pet goes to whoever accepts first |
| Stolen server key | could hand every escrowed pet to the thief's account |
| Scenarios | −~3 +~4 |

## Decision
Option A (the user, 2026-10-28). With it, decided by default and accepted by the user (2026-10-28, «tech defaults accepted»; none changes what is public or what the player pays):
- **Transfer.** Only `nft_transfer`, only by the current owner. Approvals (NEP-178: `nft_approve`, `nft_revoke`, `nft_is_approved`) and `nft_transfer_call` are not implemented: every receiver is a player, nothing in scope hands a pet to contract logic. `approval_id` has no effect: the standard ignores it when the owner transfers, and without approvals nobody else can (add-gift critic CUT 2, the user, 2026-10-28 — the own empty-`approval_id` check was dropped). `memo` must be empty — it would sit in the public event for good; this check is ours, not the standard's, and has its own rejection (add-gift critic MINOR 5). The event is the standard NEP-297 `nft_transfer` (token_id, old and new owner).
- **Everything else stays with the token_id.** Food, stage, traits, streak, freezes, outfits, the pet's known feeders and work pairs live in the pet record keyed by token_id; the transfer changes the owner only. D1 data keyed by token_id goes with the pet (`Gift ownership data`).
- **Storage on transfer.** The pet's storage paid from the pool at birth includes one owner-list record (≈ 0.001 NEAR [estimate: near-contract › What it costs], inside the 2–3 KB hypothesis of §4), so a transfer never takes unpaid storage from the contract balance: the number of non-empty owner lists never exceeds the number of pets.
- **Gas, 1 yocto and the giver's account.** The project's gas account (ADR-006) tops up the giver's wallet with the gift's gas reserve (≈ 0.005 NEAR [hypothesis], as for a portion) and the 1 yocto when they are missing, once per player, separate from the feeding top-up (add-gift critic MINOR 7, the user, 2026-10-28: replaces the accepted default «no per-player cap»; two accounts passing one pet back and forth no longer get a top-up every time); if the giver's account does not exist, the same transfer creates it (0.007 NEAR on top, volatile). A giver whose gift top-up was used pays the gift's gas from their own NEAR. Below one top-up → `Gift flow` › «подарки на паузе». A service pause (server account gas, NEAR AI limit) does not stop a gift: the giver's wallet pays its gas.
- **Signing.** As `Feeding transaction data`: the server builds, Privy signs in the giver's browser, the server sends; the browser signs only `nft_transfer` of this token_id to the accepted account it shows, with 1 yocto and empty `approval_id` and `memo`; no resend and no cancel while the outcome is unknown.
- **The hatched pet** (decided by default in the OD-700 apply round; accepted by the user 2026-10-28 — add-pet critic MAJOR 4 «Дописать обе записи», recorded in `Pet mint contract`). The contract's set of accounts that hatched a pet keeps the token_id of that pet, so the server knows which of a player's pets they hatched (Gift sheet, the current pet after a gift — `Several pets rule`); public already through the birth event, ≈ 0.0002 NEAR more storage per pet [estimate: near-contract › What it costs], paid from the pool at birth.
- **The gift link.** One per pet in D1, an unguessable code (≥ 128 random bits), no expiry (ux default accepted 2026-10-28); a bearer of the right to accept, not to take.

## Trade-off Analysis
A keeps the friend's path free of addresses and NEAR — the path the demo and the non-crypto cohort need — and adds no contract code in a 14-day build; its cost is that the giver trusts the name our server shows. B closes that gap but puts an address on the friend's path. C is the only option where a stolen server key or a leaked link moves pets.

## Consequences
- Public for good: every gift — old and new owner account — so anyone can see who gave which pet to whom.
- A stolen server key cannot move a pet; a stolen full contract key can rewrite owners; Privy, holding the players' keys, could sign a transfer.
- A hacked server could redirect a gift the owner starts to an account of its choosing under a friend's name; the browser check does not catch it.
- Gas-account spend rises: a giver with no account on chain — hatched there or received the pet as a gift — costs ≈ 0.012 NEAR (creation + reserve), every later gift of that player is paid from their own wallet. There is no per-day bound: one pet can pass through any number of new accounts a day, so a farm of fake givers spends ≈ 0.012 NEAR per new account up to the gas-account balance (≈ 125 accounts at ≈ 1.5 NEAR, PRODUCT.md §4 › Риск сибилов). At 100 givers ≈ 1.2 NEAR; the gas account is topped up to ≈ 1.5 NEAR to cover it next to feeding top-ups (OD-700, the user, 2026-10-28: «Пополнить до ≈1.5 NEAR»; ADR-006).
- Pets fed by the giver no longer find the gifted pet among known pets (known by feeding is keyed by the feeder's account); work pairs stay (`Known pets contract`).

## Action Items
1. [x] The user picks A, B or C (OD-670) — A, 2026-10-28.
2. [ ] Build day 1: confirm Privy signs the `nft_transfer` hash without a modal on mainnet.
3. [ ] Re-check the 0.007 NEAR account creation and the gas reserve size before the build.
