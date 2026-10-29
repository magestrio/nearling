import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_DB_MIGRATIONS: D1Migration[];
      TEST_EVENTS_MIGRATIONS: D1Migration[];
    }
  }
}
