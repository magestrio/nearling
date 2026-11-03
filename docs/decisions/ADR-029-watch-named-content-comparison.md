# ADR-029: Compare a watch's named content

**Status:** Accepted (the user, 2026-11-03, OD-1901, OD-1902 and the 2026-11-03b critic resolution)
**Date:** 2026-11-03
**Deciders:** the user

## Context

One daily search can return a different ranking without any change to the named topic, release, account or page. The user chose a paid check even when quiet and a diary entry only when the named content changes. `research/gap-bounded-daily-change-watch.md` finds that monitors compare saved observations; it found no measured precision for one bounded web search across these target types.

## Decision

D1 keeps one nonblank public target, the UTC hour at which it was saved, its paused state, last started UTC day, previous named-content observation, result and receipt pointer. The server attempts one check at that UTC hour on each eligible day; a blocked day is skipped without backfill. The first paid check saves a baseline without a diary entry. Later checks compare sourced topic facts, a GitHub release's published id and content, named NEAR account state, or a page's main content. Search ordering, ads, clocks and page furniture alone do not count. A completed check spends food and writes a receipt even if quiet. A failed started check consumes that day's slot without replacing the baseline; replacing the target starts a new comparison but never restores an already-used slot. A gift pauses checks until the new owner sees the target and per-check price and resumes or removes it. A watch is neither owner activity nor streak repair.

## Options considered

### A. Compare named observations (chosen)

The owner gets fewer incidental diary entries. One bounded search may also read a public structured source or page. At §4's estimate it costs the pet ≈ 0.85¢, up to ≈ 1.1¢ with retry; a standalone debit may add ≈ 0.17¢ net project gas. Provider prices and search behavior are volatile (`near-ai` › Models and prices; PRODUCT.md §4 › Watch).

### B. Treat changed search results as change

No named-content snapshot is needed, but ranking changes can create diary entries with no target change (`research/gap-bounded-daily-change-watch.md`). Food cost is similar.

### C. Notify on any page difference

Ads and timestamps can appear as news. Page snapshots add storage and traffic and do not cover a topic or account consistently.

## Consequences

- Memory clear removes target and observation; gift transfers a paused watch. A started check consumes the day even if its source fails or the target changes.
- The target goes to NEAR AI, Brave and a relevant public source or page host; their retention periods are unknown (`near-ai` › What leaves the browser; `cf-worker` › For the spec).
- One bounded search cannot promise exhaustive discovery. The research has no controlled false-positive or missed-change rate; the build should record concrete target examples without widening the product claim.
