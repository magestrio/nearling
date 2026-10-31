// The ritual of a UTC day (`Daily ritual flow`, `Ritual day rule`, `Ritual data`): which parts are
// left, when the ritual has ended, what the entry of today is, and the settle that writes the end to D1.
//
// The rules (`partsOf`, `isComplete`, `doableParts`, `splitEntry`) are pure and read the same facts in
// the route, the settle and the tests. The facts come from D1 only: the chain is never read to complete a
// ritual (design.md › Решения › Completing the ritual). The mark that follows is `pet/mark.ts`.
import { utcDay } from '../http';
import { isPaused } from '../servicePause';
import { CLAIM_STALE_MS } from './growth';
import { writeDueMark } from './mark';

/** The diary is put to the pets that do not sleep in the first 30 minutes of the UTC day. */
export const DIARY_WINDOW_MS = 30 * 60_000;
/** At most this many open rows are looked at by the cron in a tick: a look is ~12 D1 queries, and an
 * invocation has 1,000 (D1 limits) to share with the other parts of the minute. */
export const SETTLE_PER_TICK = 30;
/** At most this many pets get a streak mark written in a tick. */
export const MARKS_PER_TICK = 20;

/** The parts of a ritual: the entry read, the question answered, the riddle answered. */
export type Part = 'diary' | 'question' | 'riddle';

export type EntryKind = 'text' | 'first' | 'cleared' | 'writing' | 'asleep' | 'failed';
export type Entry = { kind: 'text'; id: string; lines: string[]; question: string | null } | { kind: Exclude<EntryKind, 'text'> };

// ---------------------------------------------------------------------------------------------
// The entry and its question

/** A line that asks: it ends in `?`, a closing quote allowed. */
const ASKS = /\?["'”’»]*$/;
/** The end of a sentence inside a paragraph: a terminator, a closing quote, then white space and more text. */
const SENTENCE_END = /[.!?]["'”’»]*\s+(?=\S)/g;

/** The entry's text as lines, and its question: the last non-empty line, or in a one-paragraph reply
 * its last sentence, when it ends in `?`. No `?` at the end, no question that day (`Ritual day rule`:
 * «вопрос дня — если он есть»); a reply cut at a limit lands here too. */
export function splitEntry(text: string): { lines: string[]; question: string | null } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last === undefined || !ASKS.test(last)) return { lines, question: null };
  if (lines.length > 1) return { lines: lines.slice(0, -1), question: last };
  let start = 0;
  for (const match of last.matchAll(SENTENCE_END)) start = match.index + match[0].length;
  const rest = last.slice(0, start).trim();
  return { lines: rest === '' ? [] : [rest], question: last.slice(start).trim() };
}

// ---------------------------------------------------------------------------------------------
// The rules

/** What the rules read. All of it is D1's (`readFacts`). */
export interface Facts {
  entry: EntryKind;
  /** The entry of today ends in a question. */
  hasQuestion: boolean;
  asleep: boolean;
  tired: boolean;
  /** A pause of the services (gas or AI) stands: the question is not available (`Ritual day rule`). */
  paused: boolean;
  /** The Diary screen really stood today (`ritual_days.opened_at`). */
  opened: boolean;
  read: boolean;
  questionAnswered: boolean;
  /** The answer to the question was sent and its thought has not landed. */
  questionOnItsWay: boolean;
  riddleSealed: boolean;
  riddleAnswered: boolean;
}

/** The parts left to do: the entry, if there is one and it is unread; the question, if there is one,
 * unanswered, and the pet is awake, not tired and not paused; the riddle, if sealed, unanswered and the
 * pet awake. An answer on its way is not a part done. */
export function partsOf(f: Facts): Part[] {
  const left: Part[] = [];
  if (f.entry === 'text' && !f.read) left.push('diary');
  if (f.hasQuestion && !f.questionAnswered && !f.asleep && !f.tired && !f.paused) left.push('question');
  if (f.riddleSealed && !f.riddleAnswered && !f.asleep) left.push('riddle');
  return left;
}

/** The ritual has ended: nothing is left, nothing blocks it (an entry being written does), and
 * something happened that day — a part done, or, for a pet asleep, the Diary opened. For an awake pet the
 * opening alone completes nothing: a day with nothing available stays a day with no ritual. */
export function isComplete(f: Facts): boolean {
  if (f.entry === 'writing') return false;
  if (partsOf(f).length > 0) return false;
  return f.read || f.questionAnswered || f.riddleAnswered || (f.asleep && f.opened);
}

/** What `GET …/diary` says is left, the source of «Today's streak still needs {parts}.»: the left parts
 * without the entry, and without a question whose answer is on its way; empty once complete. */
export function doableParts(f: Facts): Exclude<Part, 'diary'>[] {
  if (isComplete(f)) return [];
  return partsOf(f).filter((p): p is Exclude<Part, 'diary'> => p !== 'diary' && !(p === 'question' && f.questionOnItsWay));
}

// ---------------------------------------------------------------------------------------------
// The entry of today, from D1 only

export interface PetRow {
  slept_at: number | null;
  tired_day: number | null;
  diary_day: number | null;
  asleep_diary_day: number | null;
  born_at: number;
}

const PET_COLUMNS = 'slept_at, tired_day, diary_day, asleep_diary_day, born_at';

/** What the entry of today is. In the order of design.md: a diary thought of today with text, or erased;
 * a pet born today; a diary on its way or its window still open; asleep; anything else is a failure. */
export async function entryOf(db: D1Database, tokenId: string, nowMs: number, bornDay: number, pet?: PetRow | null): Promise<Entry> {
  const today = utcDay(nowMs);
  const start = today * 86_400_000;
  const thought = await db
    .prepare(
      "SELECT id, reply_text, erased_at FROM thoughts WHERE token_id = ? AND kind = 'diary' AND created_at >= ? AND (reply_text IS NOT NULL OR erased_at IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(tokenId, start)
    .first<{ id: string; reply_text: string | null; erased_at: number | null }>();
  if (thought !== null) {
    if (thought.reply_text === null) return { kind: 'cleared' };
    const { lines, question } = splitEntry(thought.reply_text);
    return { kind: 'text', id: thought.id, lines, question };
  }
  if (bornDay >= today) return { kind: 'first' };
  const row = pet ?? (await db.prepare(`SELECT ${PET_COLUMNS} FROM pets WHERE token_id = ?`).bind(tokenId).first<PetRow>());
  const onItsWay = await db.prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND kind = 'diary' AND status IN ('queued', 'running') LIMIT 1").bind(tokenId).first();
  const windowOpen = nowMs - start < DIARY_WINDOW_MS && row?.slept_at == null && (row?.diary_day == null || row.diary_day < today);
  if (onItsWay !== null || windowOpen) return { kind: 'writing' };
  if (row?.slept_at != null || row?.asleep_diary_day === today) return { kind: 'asleep' };
  return { kind: 'failed' };
}

/** The entry of today of a pet, with the pet's row (`null`: the server has none). The birth day is the
 * row's own (`born_at` in ms), not the chain's nanoseconds. */
export async function entryToday(db: D1Database, tokenId: string, nowMs: number): Promise<{ entry: Entry; pet: PetRow | null }> {
  const pet = await db.prepare(`SELECT ${PET_COLUMNS} FROM pets WHERE token_id = ?`).bind(tokenId).first<PetRow>();
  const entry = await entryOf(db, tokenId, nowMs, pet === null ? 0 : utcDay(pet.born_at), pet);
  return { entry, pet };
}

// ---------------------------------------------------------------------------------------------
// The facts, and the settle

/** The marks of a pet's ritual today (`ritual_days`). */
export interface DayRow {
  opened_at: number | null;
  read_at: number | null;
  question_at: number | null;
  riddle_at: number | null;
  completed_at: number | null;
}

/** The facts of a pet's ritual today, or `null` when the server has no row of the pet. */
export async function readFacts(env: Env, tokenId: string, nowMs: number): Promise<Facts | null> {
  return (await readDay(env, tokenId, nowMs))?.facts ?? null;
}

/** The facts of today with the entry itself and the day's row, for the route that shows them. */
export async function readDay(env: Env, tokenId: string, nowMs: number): Promise<{ facts: Facts; entry: Entry; row: DayRow | null } | null> {
  const today = utcDay(nowMs);
  const pet = await env.DB.prepare(`SELECT ${PET_COLUMNS} FROM pets WHERE token_id = ?`).bind(tokenId).first<PetRow>();
  if (pet === null) return null;
  const day = await env.DB.prepare('SELECT opened_at, read_at, question_at, riddle_at, completed_at FROM ritual_days WHERE token_id = ? AND day = ?')
    .bind(tokenId, today)
    .first<DayRow>();
  const entry = await entryOf(env.DB, tokenId, nowMs, utcDay(pet.born_at), pet);
  const sealed = await env.DB.prepare('SELECT 1 AS found FROM riddles WHERE day = ? AND sealed_at IS NOT NULL AND foreign_hash = 0').bind(today).first();
  const onItsWay = await env.DB.prepare(
    "SELECT 1 AS found FROM jobs WHERE token_id = ? AND kind = 'reply' AND status IN ('queued', 'running') AND json_extract(payload, '$.question') = ? LIMIT 1",
  )
    .bind(tokenId, today)
    .first();
  const facts: Facts = {
    entry: entry.kind,
    hasQuestion: entry.kind === 'text' && entry.question !== null,
    asleep: pet.slept_at !== null,
    tired: pet.tired_day !== null && pet.tired_day >= today,
    paused: await isPaused(env.DB, 'thought'),
    opened: day?.opened_at != null,
    read: day?.read_at != null,
    questionAnswered: day?.question_at != null,
    questionOnItsWay: onItsWay !== null,
    riddleSealed: sealed !== null,
    riddleAnswered: day?.riddle_at != null,
  };
  return { facts, entry, row: day };
}

/** Ends the ritual of today in D1 when the facts say it has ended, once, then writes what is due to the
 * chain (`writeDueMark`: also the day of an earlier end whose mark has not landed). Reads D1 only to
 * decide. Returns whether this call was the one that ended the ritual. Called after a read mark, an
 * accepted riddle answer, every job of the desk, a clear of the memory, and by the cron for every open
 * row of today. */
export async function settleRitual(env: Env, tokenId: string, nowMs: number = Date.now()): Promise<boolean> {
  const facts = await readFacts(env, tokenId, nowMs);
  let ended = false;
  if (facts !== null && isComplete(facts)) {
    const row = await env.DB.prepare('UPDATE ritual_days SET completed_at = ?3 WHERE token_id = ?1 AND day = ?2 AND completed_at IS NULL RETURNING day')
      .bind(tokenId, utcDay(nowMs), nowMs)
      .first();
    ended = row !== null;
  }
  await writeDueMark(env, tokenId);
  return ended;
}

/** The days to write that nobody called for: a retry of a failed or paused write, one that waited for
 * the chain's day, one whose writer died (its claim is stale). The ones looked at longest ago first, so a
 * pet the chain keeps refusing does not hold the others back. */
export async function markDueDays(env: Env, nowMs: number): Promise<void> {
  const due = await env.DB.prepare(
    'SELECT token_id, day FROM ritual_days WHERE completed_at IS NOT NULL AND marked_at IS NULL AND excused = 0 AND (sending_at IS NULL OR sending_at < ?1) ORDER BY COALESCE(checked_at, 0), completed_at LIMIT ?2',
  )
    .bind(nowMs - CLAIM_STALE_MS, MARKS_PER_TICK)
    .all<{ token_id: string; day: number }>();
  const pets = new Set<string>();
  for (const { token_id, day } of due.results) {
    await env.DB.prepare('UPDATE ritual_days SET checked_at = ? WHERE token_id = ? AND day = ?').bind(nowMs, token_id, day).run();
    pets.add(token_id);
  }
  for (const tokenId of pets) {
    try {
      await writeDueMark(env, tokenId);
    } catch {
      console.log('streak_failed:error');
    }
  }
}

/** The open rows of today, a few at a time, the ones looked at longest ago first: the end of the first
 * 30 minutes, a pause starting and a tired mark from a poll complete a ritual with no one on the screen
 * (`Ritual data` › «запись не написана»), at a minute's delay at most. */
export async function settleOpenRows(env: Env, nowMs: number): Promise<void> {
  const rows = await env.DB.prepare('SELECT token_id FROM ritual_days WHERE day = ? AND completed_at IS NULL AND excused = 0 ORDER BY COALESCE(checked_at, 0), token_id LIMIT ?')
    .bind(utcDay(nowMs), SETTLE_PER_TICK)
    .all<{ token_id: string }>();
  for (const { token_id } of rows.results) {
    await env.DB.prepare('UPDATE ritual_days SET checked_at = ? WHERE token_id = ? AND day = ?').bind(nowMs, token_id, utcDay(nowMs)).run();
    try {
      await settleRitual(env, token_id, nowMs);
    } catch {
      console.log('settle_failed');
    }
  }
}
