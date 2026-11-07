import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clean, tick } from '../src/cron';
import { recordExperienceEvent } from '../src/experience/events';
import { JUDGE_DELETE_AT } from '../src/judge';
import { api, harness } from './helpers/api';
import { errand, owner, richPet } from './helpers/errands';
import { addPets, advise, PAYER, payerToken, WORKER, WORKER_OWNER } from './helpers/work';
import { approveExperience, EXPERIENCE_OWNER, EXPERIENCE_PET, experienceToken,
  publishExperience, savedExperience } from './helpers/experience';

const h = harness();
const ids = { tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  playerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', petId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const rows = () => env.EVENTS.prepare('SELECT name, approved, experience, tab_id, player_id, pet_id FROM experience_events ORDER BY rowid')
  .all<{ name: string; approved: number | null; experience: number | null; tab_id: string | null; player_id: string | null; pet_id: string | null }>();

describe('experience code-only events', () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    await env.EVENTS.prepare('DELETE FROM experience_events').run();
  });

  // spec: add-pet-experience › Experience events data › owner approval action
  it('writes approved and published outcomes into EVENTS without notes, owners or token IDs', async () => {
    h.net().contract.addPet(EXPERIENCE_PET, EXPERIENCE_OWNER);
    await savedExperience();
    const tk = await experienceToken();
    expect((await approveExperience(tk, true)).status).toBe(200);
    expect((await publishExperience(tk)).status).toBe(200);
    expect((await approveExperience(tk, false)).status).toBe(200);
    expect((await rows()).results).toEqual([
      { name: 'experience_note_approved', approved: 1, experience: null, tab_id: null, player_id: null, pet_id: null },
      { name: 'experience_field_published', approved: null, experience: null, tab_id: null, player_id: null, pet_id: null },
      { name: 'experience_note_approved', approved: 0, experience: null, tab_id: null, player_id: null, pet_id: null },
    ]);
    expect(JSON.stringify((await rows()).results)).not.toContain('The Leonids');
    expect(JSON.stringify((await rows()).results)).not.toContain(EXPERIENCE_OWNER);
  });

  // spec: add-pet-experience › Experience events data › public record opened
  it('takes only ordinary opaque IDs for a record-open event and rejects private properties', async () => {
    expect((await api('/api/experience/record-opened', { body: { ...ids, tokenId: EXPERIENCE_PET } })).status).toBe(400);
    expect((await api('/api/experience/record-opened', { body: { ...ids, playerId: EXPERIENCE_OWNER } })).status).toBe(400);
    expect((await rows()).results).toEqual([]);
    expect((await api('/api/experience/record-opened', { body: ids })).status).toBe(204);
    expect((await rows()).results).toEqual([{ name: 'experience_record_opened', approved: null,
      experience: null, tab_id: ids.tabId, player_id: ids.playerId, pet_id: ids.petId }]);
  });

  // spec: add-pet-experience › Experience events data › owner approval action
  it('records note-save and hire-experience codes and erases event rows at the playtest deadline', async () => {
    await recordExperienceEvent(env, 'experience_note_saved');
    await recordExperienceEvent(env, 'pet_hired', { experience: true });
    await recordExperienceEvent(env, 'pet_hired', { experience: false });
    expect((await rows()).results.map((row) => [row.name, row.experience])).toEqual([
      ['experience_note_saved', null], ['pet_hired', 1], ['pet_hired', 0],
    ]);
    await clean(env, JUDGE_DELETE_AT);
    expect((await rows()).results).toEqual([]);
    vi.setSystemTime(JUDGE_DELETE_AT);
    await recordExperienceEvent(env, 'experience_note_saved');
    expect((await rows()).results).toEqual([]);
  });

  // spec: add-pet-experience › Experience capture flow › eligible report
  // spec: add-pet-experience › Experience events data › owner approval action
  it('writes a saved-note event only after an accepted paid errand', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ content: 'The Leonids peak in November.\nWORK_NOTE: The Leonids peak in November.\nWORK_FIELD: the Leonids meteor shower' });
    await errand(tk, 'read', 'Read this report.');
    expect((await rows()).results).toEqual([]);
    await tick(env, Date.now() + 11 * 60_000);
    expect((await rows()).results.map((row) => row.name)).toEqual(['experience_note_saved']);
  });

  // spec: add-pet-experience › Experience use flow › approved context
  it('marks a settled hire with whether its answer actually used approved experience', async () => {
    addPets(h);
    const noteId = 'd'.repeat(24);
    await env.DB.prepare(`INSERT INTO thoughts (id, token_id, created_at, kind, model, price_yocto,
      price_usd_micros, payer, status, debit_tx_hash) VALUES (?, ?, ?, 'errand', 'model', '100', 1,
      'pet', 'billed', 'tx')`).bind(noteId, WORKER, Date.now()).run();
    await env.DB.prepare(`INSERT INTO experience_notes (source_thought_id, token_id, note_text,
      proposed_field, source_report_id, created_at, memory_epoch, owner_account, owner_generation,
      status, approved_generation) VALUES (?, ?, 'The soil stayed moist under mulch.', 'gardening',
      ?, ?, 0, ?, 0, 'active', 0)`).bind(noteId, WORKER, noteId, Date.now(), WORKER_OWNER).run();
    const tk = await payerToken();
    const answer = await advise(tk);
    expect(answer.thought).toBeDefined();
    expect((await env.DB.prepare('SELECT experience FROM hires WHERE hirer_id = ?').bind(PAYER).first<{ experience: number }>())?.experience).toBe(1);
    await tick(env, Date.now() + 11 * 60_000);
    expect((await rows()).results.map((row) => [row.name, row.experience])).toEqual([['pet_hired', 1]]);
  });
});
