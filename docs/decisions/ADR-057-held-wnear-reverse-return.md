# ADR-057: Return held wNEAR through a reverse 1-Click quote

**Status:** Accepted — user gate decision 2026-11-11
**Date:** 2026-11-11
**Deciders:** the user

## Context

ADR-054 releases held wNEAR only to a project settlement account. The source payer needs USDC on Base or Solana, and a release is not a refund. `research/gap-how-the-project-operator-can-return-a-held-wnear-delivery-to-the-payer-on-the-origin-chain.md` §3 found a reverse 1-Click quote route. Its live minimum, output and fees are volatile; no signed reverse transfer was tested.

## Options considered

| Option | Player outcome | Project cost and custody |
| --- | --- | --- |
| A. Reverse 1-Click wNEAR→USDC quote | Payer sees verified recipient and net/minimum USDC after fees, then a separate confirmed source transfer; amounts below the live minimum remain held | Sampled app fee 0.2%; sampled destination withdraw fee 0.010005 Solana USDC or 0.002400 Base USDC, already in `amountOut`; NEAR release/deposit gas unmeasured; 1-Click receives wNEAR during the route |
| B. Direct USDC transfer from a funded project source wallet | Payer sees a direct source transfer, including small amounts if funding permits | Project must stock USDC and SOL or Base ETH and control another signing key; source gas unquoted; source wallet custody and key exposure grow |

## Decision

Option A. Before releasing held wNEAR, the operator verifies the origin transfer and USDC recipient, requests a payable reverse quote with `originAsset=nep141:wrap.near`, destination USDC on the original chain, `recipientType=DESTINATION_CHAIN`, and the verified address as `recipient`. The reverse quote's `refundTo` is the project's NEAR settlement account. A quoted amount below the service's live minimum stays in contract custody. The operator releases wNEAR, sends it to the quote's NEAR deposit address, and treats only a confirmed origin-chain USDC transfer as a completed refund.

## Consequences

- The matched payer link shows quoted net and minimum USDC after fees, then actual received USDC when confirmed; the pet owner sees public proof without the private quote-route refund address.
- A failed exchange is still unresolved. The operator recovers wNEAR to the project account and retries a fresh quote; until recovery, status says the amount is held for return, without implying it remains in the game contract.
- The observed return floors and fees are volatile. Research dry quotes accepted 0.003 wNEAR for Solana and 0.001 wNEAR for Base, while smaller sampled amounts failed; these observations do not set a stable minimum. No signed return was tested. Project gas and actual USDC received remain build measurements.
