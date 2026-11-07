import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// spec: add-pet-society › Society bounds rule › daily line bound
it('migrates only private, keyed relationship and diary memory into game D1', async () => {
  const schema = (await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'society_%' ORDER BY name",
  ).all<{ name: string; sql: string }>()).results;
  expect(schema.map((row) => row.name)).toEqual([
    'society_diary_lines', 'society_encounters', 'society_processed_hires', 'society_relations',
  ]);
  expect(schema.find((row) => row.name === 'society_relations')?.sql).toContain('PRIMARY KEY (token_id, other_id)');
  expect(schema.find((row) => row.name === 'society_diary_lines')?.sql).toContain('slot BETWEEN 1 AND 3');
  const events = (await env.EVENTS.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'society_%'")
    .all<{ sql: string }>()).results;
  expect(events.every((row) => !/\b(question|answer|email|account_id|token_id|line_text|note_text)\s+/i.test(row.sql)))
    .toBe(true);
  expect(schema.every((row) => !/account|question|answer|email/i.test(row.sql))).toBe(true);
  for (let slot = 1; slot <= 3; slot++) {
    await env.DB.prepare('INSERT INTO society_diary_lines (token_id, day, slot, line) VALUES (?, ?, ?, ?)')
      .bind('migration-bound', 1, slot, 'A private line').run();
  }
  await expect(env.DB.prepare('INSERT INTO society_diary_lines (token_id, day, slot, line) VALUES (?, ?, ?, ?)')
    .bind('migration-bound', 1, 4, 'Fourth line').run()).rejects.toThrow();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM society_diary_lines WHERE token_id = 'migration-bound'")
    .first<{ n: number }>())?.n).toBe(3);
});
