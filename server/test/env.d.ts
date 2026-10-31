import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_DB_MIGRATIONS: D1Migration[];
      TEST_EVENTS_MIGRATIONS: D1Migration[];
      // The contract's numbers from contract/src/limits.rs (vitest.config.ts), decimal strings.
      MAX_CHARACTER_BYTES: string;
      STARTER_FOOD: string;
      MAX_BIRTH_COST: string;
      MIN_FEED: string;
      SNACK_AMOUNT: string;
      FRIEND_SNACKS_PER_DAY: string;
      OWNER_SNACK_EVERY_NS: string;
      // presets.md › Slots as JSON: string[][].
      PRESETS_MD: string;
    }
  }
}
