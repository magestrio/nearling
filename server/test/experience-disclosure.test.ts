import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/cron';
import { api, harness } from './helpers/api';
import { errand, owner, PET, richPet, thoughtsOf } from './helpers/errands';

const h = harness();

describe('experience report disclosure', () => {
  // spec: add-pet-experience › Experience report disclosure data › receipt publication
  it('warns before exact-byte publication and marks the published proof without exposing private note data in the index', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: 'The Leonids peak in November.\nWORK_NOTE: The Leonids peak in November.\nWORK_FIELD: the Leonids meteor shower' });
    await errand(tk, 'read', 'Read this short report about the Leonids.');
    const thought = (await thoughtsOf())[0]!;
    const detail = await api(`/api/verification/pets/${PET}/thoughts/${thought.id}`, { token: tk });
    expect(detail.body.containsWorkNote).toBe(true);
    expect(detail.body.publicationWarning).toBe("This may reveal Pixel's work note along with the report.");
    expect(detail.body.paidWork).toBe(false);
    const index = await api(`/api/verification/pets/${PET}`);
    expect(JSON.stringify(index.body)).not.toContain('The Leonids peak in November.');
    await tick(env, Date.now() + 11 * 60_000);
    const published = await api(`/api/verification/pets/${PET}/thoughts/${thought.id}/links`,
      { token: tk, body: { operationId: 'experience_note_link_001' } });
    expect(published.status).toBe(200);
    const shared = await api(`/api/verification/receipts/${published.body.code}`);
    expect(shared.body.thought.containsWorkNote).toBe(true);
    expect(shared.body.thought.paidWork).toBe(true);
    expect(JSON.stringify(shared.body)).not.toContain('The Leonids peak in November.');
    const call = await env.DB.prepare('SELECT res_bytes FROM thought_calls WHERE thought_id = ?').bind(thought.id).first<{ res_bytes: number[] }>();
    expect(new TextDecoder().decode(new Uint8Array(call!.res_bytes))).toContain('WORK_NOTE: The Leonids peak in November.');
  });
});
