// The read cache of data sources (`Data source call data`): an output kept at most 60 s under a key made of the address,
// the tool and the values, in memory only. Nothing is written to storage, so an output lives only until the isolate
// is evicted or its minute ends; no D1, log or event ever holds it.
import { DurableObject } from 'cloudflare:workers';

export const SOURCE_CACHE_TTL_MS = 60_000;
/** A local bound: 500 outputs of ≤ 16,000 characters are a few MB of memory. */
const MAX_ENTRIES = 500;

export class SourceCache extends DurableObject<Env> {
  private readonly entries = new Map<string, { output: string; at: number }>();

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (Date.now() - entry.at >= SOURCE_CACHE_TTL_MS) {
      this.entries.delete(key);
      return null;
    }
    return entry.output;
  }

  put(key: string, output: string): void {
    const now = Date.now();
    for (const [k, entry] of this.entries) if (now - entry.at >= SOURCE_CACHE_TTL_MS) this.entries.delete(k);
    // Map keeps insertion order: the oldest goes first when the bound is reached.
    if (!this.entries.has(key) && this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { output, at: now });
  }
}
