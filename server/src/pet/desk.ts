// PetDesk: one Durable Object per pet that spends its thoughts one at a time (Thought queue data).
// The jobs themselves are rows of D1 (`jobs`), so a thought still comes if the tab closes or this
// object is evicted: the alarm runs the queue again. Within one instance a promise chain makes two
// callers wait for each other, and the job is claimed in D1 before it runs, so a second instance
// (after an eviction) never takes a job twice.
import { DurableObject } from 'cloudflare:workers';
import { utcDay } from '../http';
import { run, type JobResult } from '../spend';
import type { ThoughtJob } from '../prompt';

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

export function jobOf(row: Row): ThoughtJob {
  const data = row.payload === null ? {} : (JSON.parse(row.payload) as Record<string, unknown>);
  switch (row.kind) {
    case 'reply':
      return { kind: 'reply', mode: row.mode === 'deep' ? 'deep' : 'chat', text: String(data.text ?? '') };
    case 'wake':
      return { kind: 'wake', cause: (data.cause as 'owner' | 'link' | 'work') ?? 'owner', friend: typeof data.friend === 'string' ? data.friend : undefined };
    case 'diary':
      return { kind: 'diary', day: Number(data.day ?? 0) };
    default:
      return { kind: 'greeting' };
  }
}

/** Queues a job of a pet; returns its id. The caller then asks the desk to run it. */
export async function enqueueJob(db: D1Database, tokenId: string, job: ThoughtJob): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const payload =
    job.kind === 'reply' ? { text: job.text } : job.kind === 'wake' ? { cause: job.cause, friend: job.friend ?? null } : job.kind === 'diary' ? { day: job.day } : {};
  await db
    .prepare("INSERT INTO jobs (id, token_id, kind, mode, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
    .bind(id, tokenId, job.kind, job.kind === 'reply' ? job.mode : null, JSON.stringify(payload), Date.now())
    .run();
  return id;
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
        result = await run(this.env, tokenId, jobOf(row), row.epoch);
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
      await this.env.DB.prepare('UPDATE jobs SET status = ?1, result = ?2, payload = CASE WHEN ?3 = 1 THEN payload END WHERE id = ?4')
        .bind(status, JSON.stringify(result), keep ? 1 : 0, row.id)
        .run();
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
