// The ritual of the day for the owner (`Diary screen`, `Daily ritual flow`, `Riddle rule`, `Streak rule`):
// the diary the screen draws (`GET …/diary`, which marks nothing), the read mark, the answer to the
// question of the day and the answer to the riddle. The order of a route's checks (design.md › Worker):
// the request limit -> the input -> the owner from the contract, never cached -> the pause or the day ->
// the write. A pet given away is turned away with `403 not_owner` before anything is read.
import { Hono } from 'hono';
import type { PetRecord } from '../chain';
import { utcDay, type AppEnv } from '../http';
import { hasVisible } from '../name/clean';
import { enqueueQuestion } from '../pet/desk';
import { noteDeed, noteMood } from '../pet/life';
import { doableParts, entryToday, isComplete, readDay } from '../pet/ritual';
import { forecastOf } from '../pet/streak';
import { isPaused } from '../servicePause';
import { track } from '../track';
import { workOfDay } from '../work/record';
import { ownedPet, run, settleLater } from './thoughts';

export const diaryRoutes = new Hono<AppEnv>();

/** The owner's answer to the question of the day: as long as a reply (`POST …/thoughts`). */
const MAX_ANSWER_CODE_POINTS = 500;
/** The answer to the riddle: one line, 40 characters (`Riddle rule`). */
const MAX_RIDDLE_CODE_POINTS = 40;
const DAY_MS = 86_400_000;
/** A line break: CR, LF, NEL and the Unicode line and paragraph separators. */
const LINE_BREAK = /[\r\n\u0085\p{Zl}\p{Zp}]/u;

/** The server's row of the pet, made from the chain's when the pet has none yet (a thought makes it
 * too): the ritual reads the pet's condition from it. */
async function ensurePetRow(env: Env, tokenId: string, pet: PetRecord): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)')
    .bind(tokenId, pet.owner_id, Math.floor(pet.born_at / 1_000_000), '')
    .run();
}

const normal = (s: string) => s.trim().toLowerCase();

interface RiddleRow {
  text: string;
  answers: string;
  sealed_at: number | null;
  revealed_at: number | null;
  foreign_hash: number;
}

const RIDDLE_COLUMNS = 'text, answers, sealed_at, revealed_at, foreign_hash';
/** A riddle is open to the owners only once its commit is on chain and no foreign hash took the day. */
const isOpen = (r: RiddleRow | null): r is RiddleRow => r !== null && r.sealed_at !== null && r.foreign_hash === 0;

// ---------------------------------------------------------------------------------------------
// GET …/diary

diaryRoutes.get('/api/pets/:id/diary', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const { pet, id } = owned;
  const now = Date.now();
  const today = utcDay(now);
  await ensurePetRow(c.env, id, pet);
  const day = (await readDay(c.env, id, now))!;
  const { facts, entry, row } = day;
  const socialLines = entry.kind === 'text' ? (await c.env.DB.prepare(
    'SELECT line FROM society_diary_lines WHERE token_id = ? AND day = ? ORDER BY slot LIMIT 3',
  ).bind(id, today).all<{ line: string }>()).results.map((item) => item.line) : [];
  const willLine = entry.kind === 'text' ? await c.env.DB.prepare(`SELECT line FROM will_diary_lines
    WHERE token_id = ? AND day = ? AND memory_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0)`)
    .bind(id, today, id).first<{ line: string }>() : null;
  const complete = row?.completed_at != null || isComplete(facts);
  const giftBoundary = await c.env.DB.prepare('SELECT last_gift_block_at FROM pets WHERE token_id = ?').bind(id).first<{ last_gift_block_at: number | null }>();
  const entryTime = entry.kind === 'text' ? await c.env.DB.prepare('SELECT created_at FROM thoughts WHERE id = ?').bind(entry.id).first<{ created_at: number }>() : null;
  const previousOwner = entryTime !== null && giftBoundary?.last_gift_block_at != null && entryTime.created_at < giftBoundary.last_gift_block_at;

  // Today's riddle: held until the commit is on chain; the owner's answer, if it is still there.
  const riddleRow = await c.env.DB.prepare(`SELECT ${RIDDLE_COLUMNS} FROM riddles WHERE day = ?`).bind(today).first<RiddleRow>();
  let riddle: Record<string, unknown> = { kind: 'held' };
  if (isOpen(riddleRow)) {
    if (row?.riddle_at != null) {
      const mine = await c.env.DB.prepare('SELECT text FROM riddle_answers WHERE token_id = ? AND day = ?').bind(id, today).first<{ text: string }>();
      riddle = { kind: 'answered', day: today, text: riddleRow.text, answer: mine?.text ?? null };
    } else {
      riddle = { kind: 'open', day: today, text: riddleRow.text };
    }
  }

  // Yesterday's: a verdict only for a riddle that is revealed; a riddle that never opened gets no block.
  // The answer is the first accepted one, for everyone, whichever the owner guessed.
  const before = await c.env.DB.prepare(`SELECT ${RIDDLE_COLUMNS} FROM riddles WHERE day = ?`).bind(today - 1).first<RiddleRow>();
  let yesterday: Record<string, unknown> | null = null;
  if (isOpen(before)) {
    if (before.revealed_at === null) {
      yesterday = { kind: 'waiting' };
    } else {
      const mine = await c.env.DB.prepare('SELECT correct FROM riddle_answers WHERE token_id = ? AND day = ?').bind(id, today - 1).first<{ correct: number }>();
      yesterday = { kind: mine === null ? 'none' : mine.correct === 1 ? 'solved' : 'wrong', answer: (JSON.parse(before.answers) as string[])[0] ?? '' };
    }
  }

  // The answer to the question and the pet's reply under it, while the words are there.
  let exchange: { answer: string; reply: string } | null = null;
  if (row?.question_at != null) {
    const said = await c.env.DB.prepare("SELECT player_text, reply_text FROM thoughts WHERE token_id = ? AND kind = 'question' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .bind(id, today * DAY_MS)
      .first<{ player_text: string | null; reply_text: string | null }>();
    if (said?.player_text != null && said.reply_text != null) exchange = { answer: said.player_text, reply: said.reply_text };
  }

  // A changed watch belongs to this UTC day's Diary, independently of the ritual's read mark.
  // Stopping a target keeps past entries; Clear memory removes the words from their thoughts.
  const watch = await c.env.DB.prepare(`SELECT t.id, t.player_text AS target, t.reply_text AS change,
      t.sources, t.price_yocto AS priceYocto
    FROM watch_checks c JOIN thoughts t ON t.id = c.receipt_id
    WHERE c.token_id = ? AND c.day = ? AND c.status = 'paid' AND c.changed = 1
      AND t.erased_at IS NULL AND t.player_text IS NOT NULL AND t.reply_text IS NOT NULL
    ORDER BY c.started_at`)
    .bind(id, today).all<{ id: string; target: string; change: string; sources: string | null; priceYocto: string }>();

  return c.json({
    day: today,
    closedAt: new Date(today * DAY_MS).toISOString(),
    until: new Date((today + 1) * DAY_MS).toISOString(),
    // `work`: the hires recorded in the day before this entry's (`Work diary rule`); the client writes the line.
    entry: entry.kind === 'text' ? { kind: 'text', id: entry.id, lines: entry.lines,
      ...(socialLines.length > 0 ? { socialLines } : {}), question: entry.question,
      ...(willLine !== null ? { willLine: willLine.line } : {}),
      work: await workOfDay(c.env.DB, id, today - 1), ...(previousOwner ? { previousOwner: true } : {}) } : { kind: entry.kind },
    read: facts.read,
    exchange,
    watch: watch.results.map((item) => ({ target: item.target, change: item.change,
      sources: item.sources === null ? [] : JSON.parse(item.sources), priceYocto: item.priceYocto,
      receiptId: item.id })),
    riddle,
    yesterday,
    streak: await streakOf(c.env, id, pet, today, complete),
    parts: complete ? [] : doableParts(facts),
    complete,
  });
});

interface StreakRow {
  day: number;
  excused: number;
  completed_at: number | null;
  marked_at: number | null;
}

/** The streak the screen shows: the chain's number, or the forecast of the coming mark after a miss
 * (`Streak rule`), the earned line and the notes under it. */
async function streakOf(env: Env, tokenId: string, pet: PetRecord, today: number, complete: boolean) {
  const rows = (await env.DB.prepare('SELECT day, excused, completed_at, marked_at FROM ritual_days WHERE token_id = ?').bind(tokenId).all<StreakRow>()).results;
  const clock = await env.DB.prepare('SELECT closed_day FROM ritual_clock WHERE id = 1').first<{ closed_day: number }>();
  const gifted = await env.DB.prepare('SELECT gifted_unmarked FROM pets WHERE token_id = ?').bind(tokenId).first<{ gifted_unmarked: number }>();
  const last = pet.last_streak_day;
  const covered = new Set<number>();
  for (const r of rows) if (r.marked_at === null && (r.excused === 1 || r.completed_at !== null)) covered.add(r.day);
  const forecast = forecastOf({
    streak: pet.streak,
    freezes: pet.freezes,
    last,
    today,
    covered,
    closedDay: clock?.closed_day ?? 0,
    gifted: gifted?.gifted_unmarked === 1,
  });
  // A completed day the mark has not reached, and a completed one the mark could not reach in time.
  const saving = rows.some((r) => r.completed_at !== null && r.marked_at === null && r.excused === 0);
  const lost = rows.some((r) => r.completed_at !== null && r.marked_at === null && r.excused === 1);
  // With the last mark today's or yesterday's there is no gap, so an earned freeze never meets a forecast.
  const earned = forecast === null && pet.streak > 0 && pet.streak % 7 === 0 && last !== null && (last === today || last === today - 1);
  const note: ('forecast' | 'saving' | 'lost')[] = [];
  if (saving) note.push('saving');
  else if (forecast !== null) note.push('forecast');
  if (lost) note.push('lost');
  return {
    days: forecast?.days ?? pet.streak,
    freezes: forecast?.freezes ?? pet.freezes,
    done: complete,
    line: forecast !== null ? forecast.line : earned ? 'earned' : null,
    n: pet.streak,
    k: forecast?.k ?? pet.freezes,
    missed: forecast?.missed ?? 0,
    note,
  };
}

// ---------------------------------------------------------------------------------------------
// POST …/diary/read

// The Diary screen stood: `opened_at`, and the entry shown is read. Sent by the client from a screen that
// really stands, at any opening — by itself, «Today» or the address — and again when an entry appears.
// A sleeping pet with no opening today gets nothing written (`Ritual data`): the server checks it too, so
// a hand-made request cannot grow the streak of a pet that slept all day.
diaryRoutes.post('/api/pets/:id/diary/read', async (c) => {
  const body = await c.req.json<{ day?: unknown }>().catch(() => null);
  if (body === null || !Number.isInteger(body.day)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const now = Date.now();
  const today = utcDay(now);
  // Another day than the Worker's: nothing is written (the screen of a day that has passed).
  if (body.day !== today) return c.json({ ok: true });
  await ensurePetRow(c.env, owned.id, owned.pet);
  const { facts, entry } = (await readDay(c.env, owned.id, now))!;
  if (facts.asleep && !facts.opened) return c.json({ ok: true });

  if (!facts.asleep) {
    await c.env.DB.prepare('INSERT INTO ritual_days (token_id, day, opened_at) VALUES (?1, ?2, ?3) ON CONFLICT (token_id, day) DO UPDATE SET opened_at = COALESCE(opened_at, excluded.opened_at)')
      .bind(owned.id, today, now)
      .run();
  }
  if (entry.kind === 'text') {
    const read = await c.env.DB.prepare('UPDATE ritual_days SET read_at = ?3 WHERE token_id = ?1 AND day = ?2 AND read_at IS NULL RETURNING day').bind(owned.id, today, now).first();
    if (read !== null) track('ritual_completed', { part: 'diary' });
  }
  settleLater(c, owned.id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// POST …/diary/answer

diaryRoutes.post('/api/pets/:id/diary/answer', async (c) => {
  const body = await c.req.json<{ text?: unknown; day?: unknown }>().catch(() => null);
  if (body === null || typeof body.text !== 'string' || !Number.isInteger(body.day)) return c.json({ code: 'bad_request' }, 400);
  if ([...body.text].length > MAX_ANSWER_CODE_POINTS || !hasVisible(body.text)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  // On a pause the answer is not taken: nothing queued, reserved or spent.
  if (await isPaused(c.env.DB, 'thought')) return c.json({ code: 'paused' }, 409);
  const now = Date.now();
  const today = utcDay(now);
  if (body.day !== today) return c.json({ code: 'late' }, 409);
  await ensurePetRow(c.env, owned.id, owned.pet);
  const { entry } = await entryToday(c.env.DB, owned.id, now);
  if (entry.kind !== 'text' || entry.question === null) return c.json({ code: 'no_question' }, 409);

  const job = await enqueueQuestion(c.env.DB, owned.id, body.text, today, owned.pet.owner_id);
  if (job === null) return c.json({ code: 'already' }, 409);
  run(c, owned.id);
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------------------------------------
// POST …/riddle

diaryRoutes.post('/api/pets/:id/riddle', async (c) => {
  const body = await c.req.json<{ text?: unknown; day?: unknown }>().catch(() => null);
  if (body === null || typeof body.text !== 'string' || !Number.isInteger(body.day)) return c.json({ code: 'bad_request' }, 400);
  if ([...body.text].length > MAX_RIDDLE_CODE_POINTS || LINE_BREAK.test(body.text) || !hasVisible(body.text)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const now = Date.now();
  const today = utcDay(now);
  // Late first: an answer for a day that has gone writes nothing, counts for neither the ritual, the mood
  // nor «clever» (`Riddle rule` › «ответ опоздал»).
  if (body.day !== today) return c.json({ status: 'late' });
  await ensurePetRow(c.env, owned.id, owned.pet);
  const asleep = await c.env.DB.prepare('SELECT slept_at FROM pets WHERE token_id = ?').bind(owned.id).first<{ slept_at: number | null }>();
  if (asleep?.slept_at != null) return c.json({ code: 'asleep' }, 409);
  const riddle = await c.env.DB.prepare(`SELECT ${RIDDLE_COLUMNS} FROM riddles WHERE day = ?`).bind(today).first<RiddleRow>();
  if (!isOpen(riddle)) return c.json({ code: 'not_sealed' }, 409);

  // One answer a day, in one statement: a stale tab's send finds `riddle_at` set and changes nothing.
  const first = await c.env.DB.prepare(
    'INSERT INTO ritual_days (token_id, day, riddle_at) VALUES (?1, ?2, ?3) ON CONFLICT (token_id, day) DO UPDATE SET riddle_at = excluded.riddle_at WHERE ritual_days.riddle_at IS NULL RETURNING day',
  )
    .bind(owned.id, today, now)
    .first();
  if (first === null) return c.json({ status: 'already' });

  const correct = (JSON.parse(riddle.answers) as string[]).some((answer) => normal(answer) === normal(body.text as string));
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT OR IGNORE INTO riddle_answers (token_id, day, text, correct, answered_at) VALUES (?, ?, ?, ?, ?)').bind(owned.id, today, body.text, correct ? 1 : 0, now),
      // An answer in its day, right or wrong, lifts the mood and is a deed of «clever» (`Riddle rule`).
      ...noteMood(c.env.DB, owned.id, today),
      ...noteDeed(c.env.DB, owned.id, 'riddle'),
    ]);
  } catch (e) {
    // The batch is one transaction, so the answer, the mood and the deed are all gone; the claim above
    // is taken back, and the client's retry is a first answer, not `already` (`Riddle rule` › «ответ принят»).
    await c.env.DB.prepare('UPDATE ritual_days SET riddle_at = NULL WHERE token_id = ? AND day = ? AND riddle_at = ?').bind(owned.id, today, now).run();
    throw e;
  }
  track('ritual_completed', { part: 'riddle' });
  settleLater(c, owned.id);
  return c.json({ status: 'accepted' });
});
