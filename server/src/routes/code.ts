// A skill's code (`Skill code flow`, `Skill code data`, ADR-025): the owner's only, read from the contract with no cache
// (`ownedPet`). Writing it costs no thought and no food; the project pays for running it. The text is sealed under the skills
// key and goes back only to the current owner's Skill code sheet — never into a log, an event, a model request or another
// route's answer (`GET …/skill` carries the functions it declares and nothing else).
import { Hono } from 'hono';
import { claimAndBill, giveBackTestRun, markPassed, passedHash, takeTestRun, testRunsLeft } from '../code/caps';
import { declaredTools, paramsOf, typedValues } from '../code/declare';
import { MAX_CODE_BYTES, readDeclaration, runFunction } from '../code/runner';
import { requireSession, utcDay, type AppEnv } from '../http';
import { doorCaller, shapeOf } from '../sources/call';
import type { StoredTool } from '../sources/store';
import { hex } from '../spend';
import { track } from '../track';
import { openText, SkillUnreadable, sealText } from '../work/skill';
import { ownedPet } from './thoughts';

export const codeRoutes = new Hono<AppEnv>();

const MAX_FUNCTION_NAME = 64;
/** A bound on the sample values' field, not on the web. */
const MAX_VALUES = 1_000;

const aadOf = (tokenId: string) => `${tokenId}:code`;

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

const tooBig = (code: string): boolean => new TextEncoder().encode(code).length > MAX_CODE_BYTES;

const skillSaved = async (db: D1Database, tokenId: string): Promise<boolean> => (await db.prepare('SELECT 1 AS found FROM skills WHERE token_id = ?').bind(tokenId).first()) !== null;

const unreadable = () => {
  console.log('skill_unreadable');
  return { code: 'skill_unreadable' } as const;
};

// The code and what it declares, for the owner's sheet.
codeRoutes.get('/api/pets/:id/code', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const testsLeft = await testRunsLeft(c.env.DB, owned.id, utcDay(Date.now()));
  const row = await c.env.DB.prepare('SELECT ct, iv, functions FROM skill_code WHERE token_id = ?').bind(owned.id).first<{ ct: ArrayLike<number>; iv: ArrayLike<number>; functions: string }>();
  if (row === null) return c.json({ code: null, functions: [], testsLeft });
  try {
    return c.json({ code: await openText(c.env, aadOf(owned.id), row), functions: JSON.parse(row.functions) as StoredTool[], testsLeft });
  } catch (e) {
    if (e instanceof SkillUnreadable) return c.json(unreadable(), 500);
    throw e;
  }
});

// «Test run»: the 20 of the day, then the game's 330, then the load and the run.
codeRoutes.post('/api/pets/:id/code/test', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ code?: unknown; fn?: unknown; values?: unknown }>().catch(() => null);
  if (body === null || typeof body.code !== 'string' || typeof body.fn !== 'string') return c.json({ code: 'bad_request' }, 400);
  const values = body.values === undefined ? '' : body.values;
  if (typeof values !== 'string' || values.length > MAX_VALUES || tooBig(body.code) || body.fn.length < 1 || body.fn.length > MAX_FUNCTION_NAME) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (!(await skillSaved(c.env.DB, owned.id))) return c.json({ code: 'no_skill' }, 409);

  const day = utcDay(Date.now());
  // The pet's own 20 first: nothing loads once they are gone.
  if (!(await takeTestRun(c.env.DB, owned.id, day))) return c.json({ code: 'tests_used_up' }, 429);
  const hash = await sha256(body.code);
  const version = `${owned.id}:${hash}`;
  if ((await claimAndBill(c.env, day, version)) === 'capped') {
    await giveBackTestRun(c.env.DB, owned.id, day);
    console.log('code_capped');
    track('skill_code_ran', { outcome: 'capped', job: 'test' });
    return c.json({ code: 'game_capped' }, 429);
  }

  const ended = (outcome: 'ok' | 'limit' | 'error') => {
    console.log(`code_run:${outcome}`);
    track('skill_code_ran', { outcome, job: 'test' });
  };

  const read = await readDeclaration(c.env, version, body.code);
  if (read.outcome !== 'ok') {
    ended(read.outcome);
    return c.json(read.outcome === 'limit' ? { outcome: 'limit' } : { outcome: 'error', error: read.message });
  }
  const tools = declaredTools(read.declaration) ?? [];
  if (!tools.some((t) => t.name === body.fn)) {
    // It loaded to be read and nothing ran, and it is one of the pet's 20 of the day (`Skill code data` › «an undeclared function»).
    ended('error');
    return c.json({ outcome: 'undeclared', fn: body.fn });
  }

  const result = await runFunction(c.env, version, body.code, body.fn, typedValues(paramsOf(read.declaration, body.fn), values), await shapeOf(c.env.DB, owned.id), doorCaller(c.env, owned.id, 'test'));
  ended(result.outcome);
  if (result.outcome === 'limit') return c.json({ outcome: 'limit' });
  if (result.outcome === 'error') return c.json({ outcome: 'error', error: result.message });
  await markPassed(c.env.DB, owned.id, day, hash);
  const saved = await c.env.DB.prepare('SELECT functions FROM skill_code WHERE token_id = ?').bind(owned.id).first<{ functions: string }>();
  const oldTicks = new Map<string, boolean>((saved === null ? [] : (JSON.parse(saved.functions) as StoredTool[])).map((t) => [t.name, t.ticked]));
  return c.json({ outcome: 'ok', output: result.output, functions: tools.map((t) => ({ ...t, ticked: t.tickable && (oldTicks.get(t.name) ?? true) }) satisfies StoredTool) });
});

// «Save code»: only the code that passed a test run today, with the functions the owner left ticked.
codeRoutes.put('/api/pets/:id/code', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const body = await c.req.json<{ code?: unknown; ticks?: unknown }>().catch(() => null);
  if (body === null || typeof body.code !== 'string' || tooBig(body.code) || !Array.isArray(body.ticks) || body.ticks.length > 200 || !body.ticks.every((t): t is string => typeof t === 'string')) {
    return c.json({ code: 'bad_request' }, 400);
  }
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (!(await skillSaved(c.env.DB, owned.id))) return c.json({ code: 'no_skill' }, 409);

  const day = utcDay(Date.now());
  const hash = await sha256(body.code);
  if ((await passedHash(c.env.DB, owned.id, day)) !== hash) return c.json({ code: 'not_tested' }, 409);
  // the version ran today, so reading it again loads nothing the day has not counted
  const read = await readDeclaration(c.env, `${owned.id}:${hash}`, body.code);
  if (read.outcome !== 'ok') return c.json({ code: 'not_tested' }, 409);
  const ticks = new Set(body.ticks);
  const tools = declaredTools(read.declaration) ?? [];
  if ([...ticks].some((name) => !tools.some((t) => t.name === name && t.tickable))) return c.json({ code: 'bad_request' }, 400);
  const functions = tools.map((t) => ({ ...t, ticked: ticks.has(t.name) }) satisfies StoredTool);
  const sealed = await sealText(c.env, aadOf(owned.id), body.code);
  // The declaration load can outlive a clear or a gift. Ownership is read again from the contract, and the
  // statement itself requires the saved skill so a clear between that read and the write cannot recreate code.
  const stillOwned = await ownedPet(c);
  if (stillOwned instanceof Response) return stillOwned;
  const written = await c.env.DB.prepare(
    `INSERT INTO skill_code (token_id, ct, iv, hash, functions, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM skills WHERE token_id = ?1)
     ON CONFLICT (token_id) DO UPDATE SET ct = excluded.ct, iv = excluded.iv, hash = excluded.hash, functions = excluded.functions, updated_at = excluded.updated_at
     WHERE EXISTS (SELECT 1 FROM skills WHERE token_id = excluded.token_id) RETURNING token_id`,
  )
    .bind(owned.id, sealed.ct, sealed.iv, hash, JSON.stringify(functions), Date.now())
    .first<{ token_id: string }>();
  if (written === null) return c.json({ code: 'no_skill' }, 409);
  console.log('code_saved');
  return c.json({ code: { functions } });
});

// «Remove code».
codeRoutes.delete('/api/pets/:id/code', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  await c.env.DB.prepare('DELETE FROM skill_code WHERE token_id = ?').bind(owned.id).run();
  return c.json({ removed: true });
});
