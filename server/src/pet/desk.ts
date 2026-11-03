// PetDesk: one Durable Object per pet that spends its thoughts one at a time (Thought queue data).
// The jobs themselves are rows of D1 (`jobs`), so a thought still comes if the tab closes or this
// object is evicted: the alarm runs the queue again. Within one instance a promise chain makes two
// callers wait for each other, and the job is claimed in D1 before it runs, so a second instance
// (after an eviction) never takes a job twice.
import { DurableObject } from 'cloudflare:workers';
import { utcDay } from '../http';
import { runErrand, type ErrandJob } from '../errands/run';
import { run, type JobResult } from '../spend';
import type { ThoughtJob } from '../prompt';
import { runAdvice, type AdviceJob } from '../work/advice';
import { runDecline, runFinish, runHire, type OfferJob } from '../work/offer';
import { failIfQueued, nextBuy, runBuy } from './buy';
import { writeDueGrowth } from './growth';
import { settleRitual } from './ritual';

/** A running job older than this belongs to an object that is gone (the longest thought takes ~150 s). */
export const STALE_RUNNING_MS = 5 * 60_000;
/** The pet this desk serves, for its alarm (a deleted name is not something to rest on). */
const TOKEN_KEY = 'tokenId';

interface Row {
  id: string;
  kind: string;
  mode: string | null;
  payload: string | null;
}

/** A claimed job with the pet's memory epoch as it stood in the very statement that claimed it. */
interface Claimed extends Row {
  epoch: number;
}

/** What a desk runs: a thought of the pet, the advice it pays a friend's pet for (`work/advice.ts`), or the owner's
 * answer to a Manual offer and «Try again» of a lost own reply (`work/offer.ts`). */
export type DeskJob = ThoughtJob | AdviceJob | OfferJob | ErrandJob;

export function jobOf(row: Row): DeskJob {
  const data = row.payload === null ? {} : (JSON.parse(row.payload) as Record<string, unknown>);
  switch (row.kind) {
    case 'hire':
      return { kind: 'hire', price: String(data.price ?? '0') };
    case 'decline':
      return data.line === true ? { kind: 'decline', line: true } : { kind: 'decline' };
    case 'finish':
      return { kind: 'finish' };
    case 'errand':
      return { kind: 'errand' };
    case 'advice':
      return { kind: 'advice', worker: String(data.worker ?? ''), text: String(data.text ?? ''), shown: String(data.shown ?? '0') };
    case 'reply':
      return {
        kind: 'reply',
        mode: row.mode === 'deep' ? 'deep' : 'chat',
        text: String(data.text ?? ''),
        ...(typeof data.question === 'number' ? { question: data.question } : {}),
      };
    case 'wake':
      return { kind: 'wake', cause: (data.cause as 'owner' | 'link' | 'work') ?? 'owner', friend: typeof data.friend === 'string' ? data.friend : undefined };
    case 'diary':
      return { kind: 'diary', day: Number(data.day ?? 0) };
    default:
      return { kind: 'greeting' };
  }
}

/** Queues a job of a pet; returns its id. The caller then asks the desk to run it. */
export async function enqueueJob(db: D1Database, tokenId: string, job: DeskJob): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const payload =
    job.kind === 'reply'
      ? { text: job.text, ...(job.question !== undefined ? { question: job.question } : {}) }
      : job.kind === 'wake'
        ? { cause: job.cause, friend: job.friend ?? null }
        : job.kind === 'diary'
          ? { day: job.day }
          : job.kind === 'advice'
            ? { worker: job.worker, text: job.text, shown: job.shown }
            : job.kind === 'hire'
              ? { price: job.price }
              : job.kind === 'decline' && job.line
                ? { line: true }
                : {};
  await db
    .prepare("INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
    .bind(id, tokenId, job.kind, job.kind === 'reply' ? job.mode : null, JSON.stringify(payload), Date.now())
    .run();
  return id;
}

/** Queues the owner's answer to the question of `day`, or returns null when a second one is not taken:
 * the day's question was answered, or an answer is queued or running (`Daily ritual flow` › «отвечает на
 * вопрос дня»: a stale tab, two sends at once). One statement, so two sends at once cannot both pass. A
 * thought that did not come leaves neither mark, so «Try again» goes through. */
export async function enqueueQuestion(db: D1Database, tokenId: string, text: string, day: number): Promise<string | null> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const row = await db
    .prepare(
      "INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at) SELECT ?1, ?2, 'reply', 'chat', ?3, 'queued', ?4 WHERE NOT EXISTS (SELECT 1 FROM ritual_days WHERE token_id = ?2 AND day = ?5 AND question_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM jobs WHERE token_id = ?2 AND kind = 'reply' AND status IN ('queued', 'running') AND json_extract(payload, '$.question') = ?5) RETURNING id",
    )
    .bind(id, tokenId, JSON.stringify({ text, question: day }), Date.now(), day)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Queues the advice of a paying pet, or returns null when one of its advice is already queued or running
 * (`Advice flow` › «вопрос отправлен»: no second question until the answer). One statement, so two sends at once
 * cannot both pass. */
export async function enqueueAdvice(db: D1Database, tokenId: string, job: AdviceJob): Promise<string | null> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const row = await db
    .prepare(
      "INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at) SELECT ?1, ?2, 'advice', NULL, ?3, 'queued', ?4 WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE token_id = ?2 AND kind = 'advice' AND status IN ('queued', 'running')) RETURNING id",
    )
    .bind(id, tokenId, JSON.stringify({ worker: job.worker, text: job.text, shown: job.shown }), Date.now())
    .first<{ id: string }>();
  return row?.id ?? null;
}

export class PetDesk extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  /** The drain that waits behind the running one: it will see every job queued until it starts. */
  private next: Promise<void> | null = null;

  /** Runs the pet's queued jobs, oldest first, one at a time. Callers queue behind each other. */
  process(tokenId: string): Promise<void> {
    if (this.next !== null) return this.next;
    const next = this.tail.then(() => {
      this.next = null;
      return this.drain(tokenId);
    });
    this.next = next;
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Arms the alarm: the queue runs even if no request is waiting for it. */
  async arm(tokenId: string): Promise<void> {
    await this.ctx.storage.put(TOKEN_KEY, tokenId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const tokenId = (await this.ctx.storage.get<string>(TOKEN_KEY)) ?? this.ctx.id.name;
    if (tokenId !== undefined) await this.process(tokenId);
  }

  private async drain(tokenId: string): Promise<void> {
    // A job left 'running' by an object that died is over for the player (the line was never
    // answered). A failed wake thought keeps what it needs for its «Try again».
    await this.env.DB.prepare(
      "UPDATE jobs SET status = 'failed', result = ?, payload = CASE WHEN kind = 'wake' THEN payload END WHERE token_id = ? AND status = 'running' AND created_at < ?",
    )
      .bind(JSON.stringify({ code: 'ai_unavailable' }), tokenId, Date.now() - STALE_RUNNING_MS)
      .run();
    for (;;) {
      // A queued purchase goes before a job: one more spend of the pet in the same one-at-a-time line
      // (`Thought queue data`). A send with no outcome is settled later by the cron and frees the line.
      const buy = await nextBuy(this.env.DB, tokenId);
      if (buy !== null) {
        try {
          await runBuy(this.env, buy);
        } catch {
          console.log('buy_failed:error');
          await failIfQueued(this.env.DB, buy.id);
        }
        continue;
      }
      // The epoch comes with the claim, in one statement: a clear that lands before it fails this job
      // (`forgetStatements`), one that lands after it differs from `epoch`, and `think` erases the words.
      const row = await this.env.DB.prepare(
        "UPDATE jobs SET status = 'running' WHERE id = (SELECT id FROM jobs WHERE token_id = ?1 AND status = 'queued' ORDER BY created_at, rowid LIMIT 1) AND status = 'queued' RETURNING id, kind, mode, payload, COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?1), 0) AS epoch",
      )
        .bind(tokenId)
        .first<Claimed>();
      if (row === null) {
        await this.rest(tokenId);
        return;
      }
      // The object can die with this job: the alarm brings a new one here, whose sweep ends it.
      await this.keepWatch(tokenId);
      let result: JobResult;
      let status = 'done';
      try {
        const job = jobOf(row);
        switch (job.kind) {
          case 'advice':
            result = await runAdvice(this.env, tokenId, job, row.epoch);
            break;
          case 'hire':
            result = await runHire(this.env, tokenId, job, row.epoch, row.id);
            break;
          case 'decline':
            result = await runDecline(this.env, tokenId, row.epoch, job.line === true);
            break;
          case 'finish':
            result = await runFinish(this.env, tokenId, row.epoch);
            break;
          case 'errand':
            result = await runErrand(this.env, tokenId, row.epoch);
            break;
          default:
            result = await run(this.env, tokenId, job, row.epoch, { jobId: row.id });
        }
      } catch {
        console.log('job_failed');
        result = { code: 'ai_unavailable' };
        status = 'failed';
      }
      // A diary that was written, or that the pet could not write today (asleep, tired), is done for the day.
      if (row.kind === 'diary' && ('thoughtId' in result || result.code === 'asleep' || result.code === 'tired' || result.code === 'no_pet')) {
        await this.env.DB.prepare('UPDATE pets SET diary_day = ? WHERE token_id = ?').bind(utcDay(Date.now()), tokenId).run();
      }
      // The line itself leaves the row when the job is over; the thought's text lives in `thoughts`.
      // A failed wake thought keeps what its «Try again» needs, read from the column: the copy this
      // loop took at the start would bring back a friend's name the owner has cleared since.
      const keep = row.kind === 'wake' && 'code' in result && result.code === 'ai_unavailable';
      await this.env.DB.prepare('UPDATE jobs SET status = ?1, result = ?2, payload = CASE WHEN ?3 = 1 THEN payload END, progress = NULL WHERE id = ?4')
        .bind(status, JSON.stringify(result), keep ? 1 : 0, row.id)
        .run();
      // A counted reply left a transition to write: after the result is stored, so the reply reaches
      // the player first, and before the next job, so the pet's next thought speaks from the new stage.
      // A write that fails is tried again by the cron; it never takes the queue down with it.
      try {
        await writeDueGrowth(this.env, tokenId);
      } catch {
        console.log('grow_failed:error');
      }
      // The job may have been the last part of the day's ritual (a question's reply, a diary landing, a
      // thought that put the pet asleep or tired). It never takes the queue down with it either.
      try {
        await settleRitual(this.env, tokenId);
      } catch {
        console.log('settle_failed');
      }
    }
  }

  private async keepWatch(tokenId: string): Promise<void> {
    await this.ctx.storage.put(TOKEN_KEY, tokenId);
    await this.ctx.storage.setAlarm(Date.now() + STALE_RUNNING_MS);
  }

  /** The queue is empty: no alarm, unless a job of a dead object is still waiting for its sweep. */
  private async rest(tokenId: string): Promise<void> {
    const orphan = await this.env.DB.prepare("SELECT 1 AS found FROM jobs WHERE token_id = ? AND status = 'running' LIMIT 1").bind(tokenId).first();
    if (orphan !== null) await this.keepWatch(tokenId);
    else await this.ctx.storage.deleteAlarm();
  }
}

/** Asks the pet's desk to run what is queued, and arms its alarm as the fallback. */
export function desk(env: Env, tokenId: string) {
  return env.PET_DESK.get(env.PET_DESK.idFromName(tokenId));
}
