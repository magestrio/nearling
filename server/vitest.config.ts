import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { KeyPairEd25519 } from 'near-api-js';
import { defineConfig } from 'vitest/config';

// Each database has its own migrations folder (ADR-019); both are applied to the test D1s in
// test/apply-migrations.ts. The dev env's config is the one tests run against.
const dbMigrations = await readD1Migrations('./migrations/db');
const eventsMigrations = await readD1Migrations('./migrations/events');

// The contract's numbers reach the tests from their one source, `contract/src/limits.rs`
// (each is a plain integer literal on one line there): the Worker's copy of a number is compared
// with it, never typed twice.
const limitsRs = readFileSync('../contract/src/limits.rs', 'utf8');
function limit(name: string): string {
  const match = new RegExp(`pub const ${name}: [a-z0-9]+ = ([0-9_]+);`).exec(limitsRs);
  if (!match) throw new Error(`${name} not found in contract/src/limits.rs`);
  return match[1]!.replaceAll('_', '');
}

// The character fragments of `openspec/changes/add-pet/presets.md` › Slots, as a list of slots,
// for the test that holds `src/character/presets.ts` to them word for word.
function presetSlots(): string[][] {
  const lines = readFileSync('../openspec/changes/add-pet/presets.md', 'utf8').split('\n');
  const slots: string[][] = [];
  let inSlots = false;
  for (const line of lines) {
    if (line.startsWith('## ')) inSlots = line === '## Slots';
    else if (inSlots && line.startsWith('### ')) slots.push([]);
    else if (inSlots && slots.length > 0 && /^\d+\. /.test(line)) slots[slots.length - 1]!.push(line.replace(/^\d+\. /, ''));
  }
  return slots;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          TEST_DB_MIGRATIONS: dbMigrations,
          TEST_EVENTS_MIGRATIONS: eventsMigrations,
          MAX_CHARACTER_BYTES: limit('MAX_CHARACTER_BYTES'),
          STARTER_FOOD: limit('STARTER_FOOD'),
          MAX_BIRTH_COST: limit('MAX_BIRTH_COST'),
          MIN_FEED: limit('MIN_FEED'),
          SNACK_AMOUNT: limit('SNACK_AMOUNT'),
          OUTFIT_PRICE: limit('OUTFIT_PRICE'),
          HIRE_FEE_MIN: limit('HIRE_FEE_MIN'),
          HIRE_FEE_MAX: limit('HIRE_FEE_MAX'),
          MAX_JOBS_PER_DAY: limit('MAX_JOBS_PER_DAY'),
          FRIEND_SNACKS_PER_DAY: limit('FRIEND_SNACKS_PER_DAY'),
          OWNER_SNACK_EVERY_NS: limit('OWNER_SNACK_EVERY_NS'),
          PRESETS_MD: JSON.stringify(presetSlots()),
          // The tests' own values: they never read the secrets of `.dev.vars` or of a deployed Worker.
          PRIVY_APP_ID: 'test-privy-app',
          PRIVY_JWKS_URL: 'https://privy.test/jwks.json',
          NEARAI_API_KEY: 'test-nearai-key',
          // A key made when this config loads, for these tests only; it signs nothing on any network
          // and no private key string is kept in the repo.
          NEAR_SERVER_KEY: KeyPairEd25519.fromRandom().toString(),
          // The gas account's key, the same way: made for these tests, it signs nothing anywhere.
          NEAR_GAS_ACCOUNT_KEY: KeyPairEd25519.fromRandom().toString(),
          // The skill key, made when this config loads for these tests only (base64 of 32 random bytes); the real
          // `SKILL_KEY` is the user's secret and is never read here.
          SKILL_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
          // The tests' list; the real `INSULT_LIST` is the user's secret and is never read here.
          INSULT_LIST: 'idiot\nfuck\nshit\nbiscuit-free\n',
          // The tests' riddles, three of them, made for these tests (`day % 3` picks one); the real
          // `RIDDLE_LIST` is the user's secret and is never read here.
          RIDDLE_LIST: JSON.stringify([
            { text: 'What has hands but cannot clap?', answers: ['a clock', 'clock'] },
            { text: 'What gets wetter the more it dries?', answers: ['a towel', 'towel'] },
            { text: 'What has keys but opens no door?', answers: ['a piano', 'piano', 'a keyboard'] },
          ]),
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
