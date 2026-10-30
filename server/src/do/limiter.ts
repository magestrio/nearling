// A request counter for one key (`ip:<ip>` or `player:<privy sub>`): the minute and the number of
// requests in it, in memory only. Nothing is written to storage, so the IP lives only in the count
// until the end of its minute (PRODUCT.md §8 › Хранение; the Durable Object's name is a hash and is
// not kept either).
import { DurableObject } from 'cloudflare:workers';

export class Limiter extends DurableObject<Env> {
  private minute = -1;
  private n = 0;

  /** Counts one request in `minute` (minutes since the epoch); false when it is over `limit`. */
  hit(minute: number, limit: number): boolean {
    if (minute !== this.minute) {
      this.minute = minute;
      this.n = 0;
    }
    this.n += 1;
    return this.n <= limit;
  }
}
