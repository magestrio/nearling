# ADR-013: Where the worn outfit lives

**Status:** Accepted — OD-601 → A «Надетое — на нашем сервере» (the user, 2026-10-28). Applied user decisions: one item worn or none; everyone sees it on the model; it adds a speech manner from the next thought and is in the request hash (Product and ux defaults 2026-10-27/28); the worker answers in its outfit (OD-492).
**Date:** 2026-10-28
**Deciders:** the user (OD-601); tech-architect (proposal)

## Context
Which items a pet owns is on chain (ADR-012). Which one it wears changes whenever the owner taps «Wear» or «Take off». The worn item enters every thought's request as a layer, so the receipt's request hash already covers it — the owner can check it in full (`Conversation access data`), others see the hash. It must hold across devices, go with the pet on a gift and survive memory deletion (ux-architect's handover).

## Options Considered

### Option A: D1, by token_id (chosen)
+~0 Scenarios. Changing clothes is instant and free and leaves nothing public. If our server closes, the items stay on chain, the worn one does not — nothing the player paid or earned is lost. The verification page shows the worn item from the server, not from chain.

### Option B: in the contract, with the items (not chosen)
+~3 Scenarios (a `outfit_wear` contract Requirement with its rejections, a visible «couldn't put it on» case). Every «Wear» and «Take off» is a server transaction ≈ $0.0023 of project gas [hypothesis: ~5 Tgas] and waits ~1–2 s for the write; every change of clothes, with its time, is public for good. Anyone, without our server, can read what the pet wears.

## Decision
Option A (OD-601, the user 2026-10-28): the worn item is a D1 row by token_id (`Wardrobe data`); the items the pet has stay in the contract (ADR-012).

## Consequences
- The worn item and unseen grants are D1 rows by token_id, served and changed only for the current owner checked against the contract on every request; a guest gets only the worn item, for the model. Not erased by memory deletion; they go with the pet on a gift.
- No gas and no public record for changing clothes; if our server closes, the worn item is lost, the items are not.
- The server learns that a notice was shown from the browser: the item's name, nothing else (the user, 2026-10-31, build add-wardrobe).
- The server takes «Wear» only for an item the pet has on chain (the user, 2026-10-31, build add-wardrobe).
