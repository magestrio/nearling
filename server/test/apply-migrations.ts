import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_DB_MIGRATIONS);
await applyD1Migrations(env.EVENTS, env.TEST_EVENTS_MIGRATIONS);
