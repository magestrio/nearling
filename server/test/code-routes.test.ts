// Reading, saving and removing a skill's code (`add-pet-errands` › `Skill code sheet screen`, `Skill code flow`, `Skill code data`):
// the owner's only, sealed in D1 under the skills key, saved only after a passing test run of today.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { utcDay } from '../src/http';
import { forgetStatements } from '../src/pet/forget';
import { writeSkill } from '../src/work/skill';
import { harness } from './helpers/api';
import { CODE, codeRow, getCode, removeCode, saveCode, sha256, testRun } from './helpers/code';
import { OTHER, PET, other, owner, petWithSkill, skillOf } from './helpers/sources';

const h = harness();
const TICKS = ['add', 'whole', 'signFor'];

/** The owner's code after a passing test run and a save. */
async function writeCode(tk: string, code = CODE, ticks = TICKS) {
  expect((await testRun(tk, { code, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
  const saved = await saveCode(tk, { code, ticks });
  expect(saved.status).toBe(200);
  return saved;
}

describe('Skill code sheet screen', () => {
  // spec: add-pet-errands › Skill code sheet screen › code already written
  it('the owner\'s GET gives the code back decrypted with its functions and the ticks; nobody else\'s does', async () => {
    const tk = await petWithSkill(h);
    expect(await getCode(tk)).toMatchObject({ status: 200, body: { code: null, functions: [], testsLeft: 20 } });
    await writeCode(tk);

    const mine = await getCode(tk);
    expect(mine.status).toBe(200);
    expect(mine.body.code).toBe(CODE);
    expect(mine.body.functions.map((f: { name: string; ticked: boolean }) => [f.name, f.ticked])).toEqual([
      ['add', true],
      ['whole', true],
      ['signFor', true],
      ['rawFeed', false],
    ]);
    expect(mine.body.testsLeft).toBe(19);

    // sealed in D1: the row holds no text of the code
    const row = await codeRow();
    expect(row.hash).toBe(await sha256(CODE));
    expect(JSON.stringify(row.ct)).not.toContain('"sum"');
    expect(String.fromCharCode(...row.ct)).not.toContain('export function add');

    // a guest, a stranger and a forged request: nothing is decrypted
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    expect((await getCode(undefined)).status).toBe(401);
    const stranger = await other();
    expect(await getCode(stranger)).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(decrypt).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Skill code sheet screen › code already written
  it('GET …/skill carries the functions the code declares and never its text, for the owner either', async () => {
    const tk = await petWithSkill(h);
    await writeCode(tk);
    const skill = await skillOf(tk);
    expect(skill.body.code.functions.map((f: { name: string }) => f.name)).toEqual(['add', 'whole', 'signFor', 'rawFeed']);
    expect(JSON.stringify(skill.body)).not.toContain('export function');
    // nothing of the code in a log or an event
    expect(h.logs().join('\n')).not.toContain('export function');
    expect(JSON.stringify(h.events())).not.toContain('export function');
  });
});

describe('Skill code flow', () => {
  // spec: add-pet-errands › Skill code flow › test passed
  it('keeps saved ticks on old functions and ticks only new tickable functions after a passing run', async () => {
    const tk = await petWithSkill(h);
    await writeCode(tk, CODE, ['add']);
    const revised = CODE.replace('  rawFeed:', '  fresh: { description: "New", params: {} },\n  rawFeed:');
    const passed = await testRun(tk, { code: revised, fn: 'add', values: '1,2' });
    expect(passed.status).toBe(200);
    expect(passed.body.functions.map((f: { name: string; ticked: boolean }) => [f.name, f.ticked])).toEqual([
      ['add', true], ['whole', false], ['signFor', false], ['fresh', true], ['rawFeed', false],
    ]);
  });

  // spec: add-pet-errands › Skill code flow › code saved
  it('saves only the text that passed a test run today; an edit after the pass refuses and leaves the saved code as it was', async () => {
    const tk = await petWithSkill(h);
    // nothing tested yet
    expect(await saveCode(tk, { code: CODE, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'not_tested' } });
    expect(await codeRow()).toBeNull();

    await writeCode(tk);
    const saved = await codeRow();
    const edited = `${CODE}\n// one more line`;
    expect(await saveCode(tk, { code: edited, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'not_tested' } });
    expect((await codeRow()).hash).toBe(saved.hash);

    // the edit passes its own test, then saves, and the sheet reads it back
    await writeCode(tk, edited, ['add']);
    const again = await getCode(tk);
    expect(again.body.code).toBe(edited);
    expect(again.body.functions.filter((f: { ticked: boolean }) => f.ticked).map((f: { name: string }) => f.name)).toEqual(['add']);
    expect((await codeRow()).hash).toBe(await sha256(edited));
  });

  // spec: add-pet-errands › Skill code flow › code saved
  // spec: add-pet-errands › Skill code flow › test from an earlier day
  it('a pass of an earlier day does not save, and a tick on a function that takes text, an unknown one or a skill-less pet is refused', async () => {
    const tk = await petWithSkill(h);
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    // text can never be ticked; an unknown name neither
    expect(await saveCode(tk, { code: CODE, ticks: ['rawFeed'] })).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await saveCode(tk, { code: CODE, ticks: ['ghost'] })).toMatchObject({ status: 400 });
    expect(await saveCode(tk, { code: CODE, ticks: 'add' })).toMatchObject({ status: 400 });
    expect(await codeRow()).toBeNull();
    // the day turns: yesterday's pass is no pass
    vi.setSystemTime((utcDay(Date.now()) + 1) * 86_400_000);
    expect(await saveCode(await owner(), { code: CODE, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'not_tested' } });
    // no skill saved: no code
    await env.DB.prepare('DELETE FROM skills').run();
    expect(await testRun(await owner(), { code: CODE, fn: 'add' })).toMatchObject({ status: 409, body: { code: 'no_skill' } });
    expect(await saveCode(await owner(), { code: CODE, ticks: [] })).toMatchObject({ status: 409, body: { code: 'no_skill' } });
  });

  // spec: add-pet-errands › Skill code flow › code saved
  it('refuses a module over 32 KB before anything is sealed, loaded or counted', async () => {
    const tk = await petWithSkill(h);
    const big = `export const functions = {};\n// ${'é'.repeat(16 * 1024)}`;
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(32 * 1024);
    expect(await testRun(tk, { code: big, fn: 'f' })).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await saveCode(tk, { code: big, ticks: [] })).toMatchObject({ status: 400 });
    expect(await testRun(tk, { code: CODE, fn: '' })).toMatchObject({ status: 400 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM code_versions').first<{ n: number }>())!.n).toBe(0);
    expect(await env.DB.prepare('SELECT 1 FROM code_tests').first()).toBeNull();
  });

  // spec: add-pet-errands › Skill code flow › code removed
  it('«Remove code» deletes the row; the skill shows no code; removing again changes nothing', async () => {
    const tk = await petWithSkill(h);
    await writeCode(tk);
    expect(await removeCode(tk)).toMatchObject({ status: 200, body: { removed: true } });
    expect(await codeRow()).toBeNull();
    expect((await skillOf(tk)).body.code).toBeNull();
    expect((await getCode(tk)).body.code).toBeNull();
    expect(await removeCode(tk)).toMatchObject({ status: 200 });
    // a stranger's request removes nothing
    await writeCode(tk);
    expect(await removeCode(await other())).toMatchObject({ status: 403 });
    expect(await codeRow()).not.toBeNull();
  });
});

describe('Skill code data', () => {
  // spec: add-pet-errands › Skill code data › test runs used up
  it('keeps the day’s 20 test runs after Clear memory and a new skill save', async () => {
    const tk = await petWithSkill(h);
    await env.DB.prepare('INSERT INTO code_tests (token_id, day, runs) VALUES (?, ?, 20)').bind(PET, utcDay(Date.now())).run();
    await env.DB.batch(forgetStatements(env.DB, PET, Date.now()));
    await writeSkill(env, PET, { label: 'Baking', instruction: 'Answer in rhymes.' }, Date.now());
    expect((await getCode(tk)).body.testsLeft).toBe(0);
    expect(await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).toMatchObject({ status: 429, body: { code: 'tests_used_up' } });
    expect(await env.DB.prepare('SELECT runs FROM code_tests WHERE token_id = ? AND day = ?').bind(PET, utcDay(Date.now())).first()).toEqual({ runs: 20 });
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('on a gift the code stays sealed as it was: the new owner reads and edits it, the giver gets 403 on every route', async () => {
    const tk = await petWithSkill(h);
    await writeCode(tk);
    const before = await codeRow();
    h.net().contract.pets.get(PET)!.owner_id = OTHER;
    const taker = await other();

    // untouched by the gift
    expect(await codeRow()).toEqual(before);
    expect((await getCode(taker)).body.code).toBe(CODE);
    const edited = `${CODE}\n// the new owner`;
    await writeCode(taker, edited, ['add']);
    expect((await getCode(taker)).body.code).toBe(edited);

    // the giver
    const giver = await owner();
    for (const answer of [await getCode(giver), await testRun(giver, { code: CODE, fn: 'add' }), await saveCode(giver, { code: CODE, ticks: [] }), await removeCode(giver)]) {
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ code: 'not_owner' });
    }
    expect((await getCode(taker)).body.code).toBe(edited);
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('the giver\'s sheet, open before the gift, saves and tests nothing after it', async () => {
    const tk = await petWithSkill(h);
    await writeCode(tk);
    // the giver passed a test run, then the gift happens before «Save code»
    expect((await testRun(tk, { code: `${CODE}\n// last edit`, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    h.net().contract.pets.get(PET)!.owner_id = OTHER;
    expect(await saveCode(tk, { code: `${CODE}\n// last edit`, ticks: ['add'] })).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect((await getCode(await other())).body.code).toBe(CODE);
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('rechecks ownership after reading the code declaration, before saving', async () => {
    const tk = await petWithSkill(h);
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    const chain = h.net().contract;
    chain.meanwhile.pet_view = async () => {
      chain.meanwhile.pet_view = async () => { chain.pets.get(PET)!.owner_id = OTHER; };
    };
    expect(await saveCode(tk, { code: CODE, ticks: TICKS })).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    expect(await codeRow()).toBeNull();
  });

  // spec: add-pet-errands › Data source data › memory cleared
  it('does not recreate code when the skill is cleared before the final write', async () => {
    const tk = await petWithSkill(h);
    expect((await testRun(tk, { code: CODE, fn: 'add', values: '1,2' })).body.outcome).toBe('ok');
    const chain = h.net().contract;
    chain.meanwhile.pet_view = async () => {
      chain.meanwhile.pet_view = async () => { await env.DB.prepare('DELETE FROM skills WHERE token_id = ?').bind(PET).run(); };
    };
    expect(await saveCode(tk, { code: CODE, ticks: TICKS })).toMatchObject({ status: 409, body: { code: 'no_skill' } });
    expect(await codeRow()).toBeNull();
  });

  // spec: add-pet-errands › Data source data › not the owner
  it('a stranger\'s test run loads nothing and spends nothing of the pet\'s or the game\'s', async () => {
    await petWithSkill(h);
    const out = await testRun(await other(), { code: CODE, fn: 'add' });
    expect(out.status).toBe(403);
    expect(await env.DB.prepare('SELECT 1 FROM code_tests').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM code_versions').first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM project_spend WHERE kind = 'code_version'").first()).toBeNull();
  });
});
