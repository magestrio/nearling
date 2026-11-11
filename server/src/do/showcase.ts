// One durable public Home copy, shared by every visitor and kept through object restarts.
import { DurableObject } from 'cloudflare:workers';
import { showcaseView, type ShowcaseNumbers } from '../chain';
import { publicVisits, type PublicVisit } from '../pet/publicVisits';
import { nearUsdPrice } from '../any-chain/quote';

export const SHOWCASE_FRESH_MS = 60_000;
export const SHOWCASE_MAX_AGE_MS = 600_000;

export interface ShowcaseCopy {
  pets: PublicVisit[];
  numbers: ShowcaseNumbers;
  nearUsdPrice: number | null;
}

interface Held {
  at: number;
  value: ShowcaseCopy | null;
}

export class Showcase extends DurableObject<Env> {
  private held: Held | null = null;
  private lastAttempt: number | null = null;
  private pending: Promise<ShowcaseCopy | null> | null = null;

  async read(): Promise<ShowcaseCopy | null> {
    this.held ??= (await this.ctx.storage.get<Held>('copy')) ?? null;
    this.lastAttempt ??= (await this.ctx.storage.get<number>('last_attempt')) ?? null;
    const now = Date.now();
    if (this.held && now - this.held.at < SHOWCASE_FRESH_MS) return this.held.value;
    if (this.pending) return this.pending;
    if (this.lastAttempt !== null && now - this.lastAttempt < SHOWCASE_FRESH_MS) return this.stale(now);
    this.pending ??= this.refresh();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async refresh(): Promise<ShowcaseCopy | null> {
    try {
      this.lastAttempt = Date.now();
      await this.ctx.storage.put('last_attempt', this.lastAttempt);
      const [pets, numbers, price] = await Promise.all([publicVisits(this.env), showcaseView(this.env), nearUsdPrice().catch(() => null)]);
      if (pets === null) throw new Error('public pet read failed');
      const value = pets.length === 0 ? null : { pets, numbers, nearUsdPrice: price };
      const held = { at: Date.now(), value };
      await this.ctx.storage.put('copy', held);
      this.held = held;
      console.log(`showcase_read:${pets.length}`);
      return value;
    } catch {
      console.log('showcase_unavailable');
      return this.stale(Date.now());
    }
  }

  private stale(now: number): ShowcaseCopy | null {
    return this.held && now - this.held.at <= SHOWCASE_MAX_AGE_MS ? this.held.value : null;
  }
}
