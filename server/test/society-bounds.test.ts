import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { applySettledReaction, relation } from '../src/society/relations';

const day = Date.UTC(2026, 10, 6);

describe('directed society bounds', () => {
  // spec: add-pet-society › Society bounds rule › two positive days
  it('likes on two distinct positive UTC days', async () => {
    await applySettledReaction(env.DB, 'positive-a', '100', '101', 'respectful', day);
    await applySettledReaction(env.DB, 'positive-b', '100', '101', 'respectful', day + 86_400_000);
    const payer = await relation(env.DB, '100', '101');
    const worker = await relation(env.DB, '101', '100');
    expect(payer).toMatchObject({ stance: 'liked', good_days: 2 });
    expect(worker).toMatchObject({ stance: 'liked', good_days: 2 });
  });

  // spec: add-pet-society › Society bounds rule › two rude days
  it('sets a 24-hour break after the second distinct rude day', async () => {
    await applySettledReaction(env.DB, 'rude-a', '110', '111', 'rude', day);
    expect((await relation(env.DB, '111', '110'))?.break_until).toBeNull();
    await applySettledReaction(env.DB, 'rude-b', '110', '111', 'rude', day + 86_400_000);
    expect(await relation(env.DB, '111', '110')).toMatchObject({
      stance: 'strained', rude_days: 2, break_until: day + 2 * 86_400_000,
    });
  });

  // spec: add-pet-society › Society bounds rule › same day repeat
  it('does not move the pair twice on the same UTC day', async () => {
    await applySettledReaction(env.DB, 'repeat-a', '120', '121', 'respectful', day);
    expect(await applySettledReaction(env.DB, 'repeat-b', '120', '121', 'respectful', day + 1_000))
      .toEqual({ processed: true, moved: [] });
    expect(await relation(env.DB, '120', '121')).toMatchObject({ stance: 'neutral', good_days: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM society_processed_hires WHERE hire_id LIKE 'repeat-%'")
      .first<{ n: number }>()).toEqual({ n: 2 });
  });

  // spec: add-pet-society › Society bounds rule › oldest neutral leaves
  it('evicts the oldest neutral, then the oldest remaining relation when all are non-neutral', async () => {
    for (let i = 1; i <= 32; i++) {
      await env.DB.prepare('INSERT INTO society_relations (token_id, other_id, created_at) VALUES (?, ?, ?)')
        .bind('130', String(i), i).run();
    }
    await env.DB.prepare("UPDATE society_relations SET stance = 'liked' WHERE token_id = '130' AND other_id = '1'").run();
    await env.DB.prepare('INSERT INTO society_relations (token_id, other_id, created_at) VALUES (?, ?, ?)')
      .bind('130', '33', 33).run();
    expect(await relation(env.DB, '130', '1')).not.toBeNull();
    expect(await relation(env.DB, '130', '2')).toBeNull();
    await env.DB.prepare("UPDATE society_relations SET stance = 'liked' WHERE token_id = '130'").run();
    await env.DB.prepare('INSERT INTO society_relations (token_id, other_id, created_at) VALUES (?, ?, ?)')
      .bind('130', '34', 34).run();
    expect(await relation(env.DB, '130', '1')).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM society_relations WHERE token_id = '130'")
      .first<{ n: number }>())?.n).toBe(32);
  });
});
