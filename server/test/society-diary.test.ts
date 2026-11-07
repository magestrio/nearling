import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { tick } from '../src/cron';
import { pendingSocial } from '../src/society/diary';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(501);
const OLD_DAY = Math.floor(Date.UTC(2036, 10, 1) / 86_400_000);

async function setup(asleep = false): Promise<string> {
  h.net().contract.addPet('501', OWNER, { name: 'Pixel' });
  h.net().contract.addPet('502', NEAR_ACCOUNT(502), { name: 'Biscuit' });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, ?)')
    .bind('501', OWNER, '', asleep ? 1 : null).run();
  await env.DB.prepare("INSERT INTO society_encounters (hire_id, token_id, other_id, day, kind) VALUES ('settled-501', '501', '502', ?, 'quarrel')")
    .bind(OLD_DAY).run();
  return token('did:privy:society-diary', OWNER);
}

describe('settled social diary', () => {
  // spec: add-pet-society › Society diary data › social line composed
  // spec: add-pet-society › Society diary flow › named social line
  it('stores a fixed line from the settled code and public name after the existing paid call', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    const tk = await setup();
    h.net().ai.push({ content: 'I watched the stars.\nSOCIAL 1: Biscuit and I had a rough day.\nHow are you?' });
    await tick(env, Date.now());
    expect(h.net().ai.calls).toHaveLength(1);
    const request = JSON.stringify(h.net().ai.calls[0]!.body.messages);
    expect(request).not.toContain('quarrel with');
    expect(request).not.toContain('Biscuit');
    expect(request).not.toContain('settled-501');
    const line = await env.DB.prepare("SELECT line FROM society_diary_lines WHERE token_id = '501'").first<{ line: string }>();
    expect(line?.line).toBe('Biscuit and I had a rough day.');
    const diary = await api('/api/pets/501/diary', { token: tk });
    expect(diary.body.entry.socialLines).toEqual(['Biscuit and I had a rough day.']);
    expect(diary.body.entry.lines).toEqual(['I watched the stars.']);
  });

  // spec: add-pet-society › Society diary flow › settled gossip
  // spec: add-pet-society › Society bounds rule › daily line bound
  it('ignores invented model lines and keeps only the settled encounter', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    await setup();
    h.net().ai.push({ content: 'SOCIAL 1: A stranger and I met.\nSOCIAL 2: Nobody was here.\nHello.' });
    await tick(env, Date.now());
    const lines = await env.DB.prepare('SELECT line FROM society_diary_lines').all<{ line: string }>();
    expect(lines.results).toEqual([{ line: 'Biscuit and I had a rough day.' }]);
    expect((await pendingSocial(env, '501', OLD_DAY + 1))).toHaveLength(0);
  });

  // spec: add-pet-society › Society diary flow › named social line
  it('does not use model lines that repeat a private hire question or answer', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    const tk = await setup();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, worker_name, recall) VALUES ('private-advice', '501', 1, 'advice', ?, ?, 'm', '0', 0, 'pet', 'billed', 'Biscuit', 1)")
      .bind('Should I tell Maya about the broken lantern?', 'Keep the broken lantern between us.').run();
    h.net().ai.push({ content: 'SOCIAL 1: Biscuit helped with "Should I tell Maya about the broken lantern?"\nSOCIAL 1: Biscuit said to keep the broken lantern between us.\nHow are you?' });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT line FROM society_diary_lines').all<{ line: string }>()).results).toEqual([{ line: 'Biscuit and I had a rough day.' }]);
    expect((await api('/api/pets/501/diary', { token: tk })).body.entry.socialLines).toEqual(['Biscuit and I had a rough day.']);
  });

  // spec: add-pet-society › Society diary data › social line composed
  // spec: add-pet-society › Society diary flow › named social line
  it('keeps a paraphrased private question out of a settled social line', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    const tk = await setup();
    await env.DB.prepare("INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status, worker_name, recall) VALUES ('private-advice', '501', 1, 'advice', ?, ?, 'm', '0', 0, 'pet', 'billed', 'Biscuit', 1)")
      .bind('Should I tell Maya about the broken lantern?', 'Keep that between us.').run();
    h.net().ai.push({ content: 'I watched the stars.\nSOCIAL 1: Biscuit helped Maya with her lantern.\nHow are you?' });
    await tick(env, Date.now());
    const diary = await api('/api/pets/501/diary', { token: tk });
    expect(diary.body.entry.socialLines).toEqual(['Biscuit and I had a rough day.']);
    expect(JSON.stringify(h.net().ai.calls[0]!.body.messages)).not.toContain('quarrel with');
    expect(JSON.stringify(h.net().ai.calls[0]!.body.messages)).not.toContain('SOCIAL');
  });

  // spec: add-pet-society › Society diary flow › named social line
  // spec: add-pet-society › Society diary flow › settled gossip
  it('uses the bond, reconciliation and gossip phrases for their settled kinds', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    await setup();
    await env.DB.prepare("UPDATE society_encounters SET kind = 'bond' WHERE hire_id = 'settled-501'").run();
    await env.DB.prepare("INSERT INTO society_encounters (hire_id, token_id, other_id, day, kind) VALUES ('reconcile-501', '501', '502', ?, 'reconcile'), ('help-501', '501', '502', ?, 'help')")
      .bind(OLD_DAY, OLD_DAY).run();
    h.net().ai.push({ content: 'How was your day?' });
    await tick(env, Date.now());
    const lines = (await env.DB.prepare("SELECT line FROM society_diary_lines WHERE token_id = '501' ORDER BY slot").all<{ line: string }>()).results;
    expect(lines.map((row) => row.line)).toEqual([
      'I think Biscuit and I are getting closer.',
      'I think Biscuit and I are finding our way back.',
      'I have a story about helping Biscuit yesterday.',
    ]);
  });

  // spec: add-pet-society › Society diary data › social line composed
  it('retires three presented encounters after a completed diary', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    await setup();
    for (let n = 2; n <= 4; n += 1) {
      await env.DB.prepare('INSERT INTO society_encounters (hire_id, token_id, other_id, day, kind) VALUES (?, ?, ?, ?, ?)')
        .bind(`settled-${n}`, '501', '502', OLD_DAY, 'help').run();
    }
    h.net().ai.push({ content: 'SOCIAL 1: A stranger appeared.\nHello.' });
    await tick(env, Date.now());
    expect((await env.DB.prepare('SELECT line FROM society_diary_lines').all()).results).toHaveLength(3);
    expect((await pendingSocial(env, '501', OLD_DAY + 1)).map((fact) => fact.hireId)).toEqual(['settled-4']);
  });

  // spec: add-pet-society › Society diary data › social line composed × diary/asleep/Clear memory/gift
  it('retains the encounter when the diary model call fails', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    await setup();
    h.net().ai.push({ status: 500 });
    await tick(env, Date.now());
    expect((await pendingSocial(env, '501', OLD_DAY + 1))).toHaveLength(1);
  });

  // spec: add-pet-society › Society bounds rule › daily line bound
  it('uses at most three of four settled encounters in one diary call', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    await setup();
    for (let n = 2; n <= 4; n += 1) {
      await env.DB.prepare('INSERT INTO society_encounters (hire_id, token_id, other_id, day, kind) VALUES (?, ?, ?, ?, ?)')
        .bind(`settled-${n}`, '501', '502', OLD_DAY, 'help').run();
    }
    h.net().ai.push({ content: 'SOCIAL 1: Biscuit and I had a rough day.\nSOCIAL 2: Biscuit helped me.\nSOCIAL 3: I helped Biscuit.\nSOCIAL 4: Biscuit waved.\nHow are you?' });
    await tick(env, Date.now());
    const rows = await env.DB.prepare("SELECT line FROM society_diary_lines WHERE token_id = '501' ORDER BY slot").all<{ line: string }>();
    expect(rows.results.map((row) => row.line)).toEqual([
      'Biscuit and I had a rough day.', 'I have a story about helping Biscuit yesterday.', 'I have a story about helping Biscuit yesterday.',
    ]);
    expect((await env.DB.prepare("SELECT reply_text FROM thoughts WHERE kind = 'diary' AND token_id = '501'").first<{ reply_text: string }>())?.reply_text).not.toContain('SOCIAL 4');
    expect((await pendingSocial(env, '501', OLD_DAY + 2))).toHaveLength(1);
  });

  // spec: add-pet-society › Society diary data › social line composed × diary/asleep/Clear memory/gift
  it('keeps the encounter while asleep and erases it with Clear memory', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    const tk = await setup(true);
    await tick(env, Date.now());
    expect(h.net().ai.calls).toHaveLength(0);
    expect((await pendingSocial(env, '501', OLD_DAY + 1))).toHaveLength(1);
    expect((await api('/api/pets/501/memory/clear', { token: tk, method: 'POST' })).status).toBe(200);
    expect((await pendingSocial(env, '501', OLD_DAY + 1))).toHaveLength(0);
  });

  // spec: add-pet-society › Society diary data › owner diary read
  it('serves a retained social line to the new owner after gift, never to the former owner', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    const oldToken = await setup();
    h.net().ai.push({ content: 'SOCIAL 1: Biscuit and I had a rough day.\nHow are you?' });
    await tick(env, Date.now());
    const newOwner = NEAR_ACCOUNT(503);
    h.net().contract.pets.get('501')!.owner_id = newOwner;
    const newToken = await token('did:privy:society-diary-new', newOwner);
    expect((await api('/api/pets/501/diary', { token: oldToken })).status).toBe(403);
    const diary = await api('/api/pets/501/diary', { token: newToken });
    expect(diary.body.entry.socialLines).toEqual(['Biscuit and I had a rough day.']);
  });

  // spec: add-pet-society › Society diary data › social line composed
  it('keeps a settled fixed line beside a paid diary with only a model marker', async () => {
    vi.setSystemTime(Date.UTC(2036, 10, 2, 0, 5));
    const tk = await setup();
    h.net().ai.push({ content: 'SOCIAL 1: Biscuit and I had a rough day.' });
    await tick(env, Date.now());
    const diary = await api('/api/pets/501/diary', { token: tk });
    expect(diary.body.entry).toMatchObject({ kind: 'text', socialLines: ['Biscuit and I had a rough day.'] });
    expect((await env.DB.prepare("SELECT status FROM thoughts WHERE kind = 'diary'").first<{ status: string }>())?.status).toBe('unbilled');
  });
});
