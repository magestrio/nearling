import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Each database has its own migrations folder (ADR-019); both are applied to the test D1s in
// test/apply-migrations.ts. The dev env's config is the one tests run against.
const dbMigrations = await readD1Migrations('./migrations/db');
const eventsMigrations = await readD1Migrations('./migrations/events');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: { TEST_DB_MIGRATIONS: dbMigrations, TEST_EVENTS_MIGRATIONS: eventsMigrations },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
