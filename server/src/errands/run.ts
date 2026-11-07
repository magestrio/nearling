// An errand on the pet's desk (`Errand flow`, `Read this flow`, `Errand price data`): the checks again, the reserve,
// the form's pipeline, one thought, the end of the errand row. The errand is one thought of the session's batch,
// priced by usage; it carries the job, the pet's character, its layers and its skill, never its memory, and what it
// reads (a page, results, data) is hostile data: no hire, no memory write, no food moves but its own price.
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { hasVisible } from '../name/clean';
import { complete, replyOf, signatureOf } from '../nearai';
import { eraseIfCleared, memoryEpoch } from '../pet/forget';
import { energyLeft, moodOf, readLife } from '../pet/life';
import { wornOf } from '../pet/outfits';
import { markTired, type FoodState } from '../pet/view';
import { ceilingPrice, EDGE_CEILING, fullness, minCallPrice, thoughtPrice, usd12ToMicros } from '../pricing';
import { inputBound, readMessages, type LifeLayers } from '../prompt';
import {
  callsUsd12,
  CHAT_TIMEOUT_MS,
  countEmpty,
  FREE_EMPTY_ANSWERS,
  hex,
  openSession,
  planOf,
  projectPays,
  randomId,
  reaskPlan,
  refusalOf,
  yoctoMicros,
  type Answer,
  type JobResult,
  type SignedCall,
} from '../spend';
import { track } from '../track';
import { readSkill, SkillUnreadable } from '../work/skill';
import { afterThought } from './after';
import { captureWorkNote, stageNote } from '../experience/capture';
import { blocksOf } from './blocks';
import { findErrand } from './find';
import { settleInterrupted } from './late';
import { cutPrice, READ_LIMIT_TOKENS, REASK_FUSE, REPORT_FUSE, need } from './price';
import { linkOf, readPage, tokensOf } from './reader';
import { awayErrand, failErrand, tokensCostUsd, type ErrandRow, type Paid } from './store';
import { settleSharedOutcome } from './sharedSettle';

/** What the desk queues for an errand: nothing but the fact; the form and the job live on the errand row. */
export type ErrandJob = { kind: 'errand' };

const FAILED: JobResult = { code: 'errand_failed' };

/** Runs the pet's errand that is away. `epoch` is `pets.memory_epoch` when the job was claimed: a clear that lands
 * meanwhile makes the report's words unwanted (`eraseIfCleared` in the thought's own batch). */
export async function runErrand(env: Env, tokenId: string, epoch: number): Promise<JobResult> {
  const row = await awayErrand(env.DB, tokenId);
  if (row === null) return FAILED;
  let result: JobResult;
  try {
    result = await go(env, tokenId, epoch, row);
  } catch (e) {
    console.log(e instanceof ChainUnreachable ? 'errand_chain' : 'errand_error');
    // A search can already be signed and stored when the data or report step throws. Its recorded searches
    // must become an unbilled failed thought; only an errand with no such thought takes the no-spend path.
    if ((await settleInterrupted(env, tokenId)) === null) await failErrand(env.DB, row, { reason: 'empty' });
    result = FAILED;
  }
  if (row.shared_job_hash != null) await settleSharedOutcome(env, row);
  return result;
}

async function go(env: Env, tokenId: string, epoch: number, row: ErrandRow): Promise<JobResult> {
  const now = Date.now();
  // The words were cleared before the job began: nothing to do and nothing was spent.
  if (row.job === null) {
    await env.DB.prepare("DELETE FROM errands WHERE token_id = ? AND id = ? AND state = 'away'").bind(tokenId, row.id).run();
    return { code: 'memory_cleared' };
  }
  const pet = await petView(env, tokenId);
  if (pet === null) {
    await env.DB.prepare('DELETE FROM errands WHERE token_id = ?').bind(tokenId).run();
    return { code: 'no_pet' };
  }
  await env.DB.prepare('INSERT OR IGNORE INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind(tokenId, pet.owner_id, now, '').run();

  // A block that holds now but did not at «Send»: nothing is spent or searched; the sheet opens with the job
  // (`Errand flow` › «blocked after Send»).
  const { block, food, hasData } = await blocksOf(env, tokenId, pet, row.form, now, true, row.shared_job_hash ?? undefined);
  if (block !== null) {
    await failErrand(env.DB, row, { reason: 'blocked' });
    return FAILED;
  }

  if (row.form !== 'read') return findErrand(env, tokenId, epoch, row, pet, food, hasData, now);
  return readErrand(env, tokenId, epoch, row, pet, food, now);
}

async function readErrand(env: Env, tokenId: string, epoch: number, row: ErrandRow, pet: PetRecord, fs: FoodState, now: number): Promise<JobResult> {
  const job = row.job!;
  // 1. The page: a link the server fetches, or the text as pasted; both checked before any model call.
  const link = linkOf(job);
  let page: string;
  if (link !== null) {
    const read = await readPage(link);
    if (read.kind !== 'ok') {
      await failErrand(env.DB, row, { reason: read.kind });
      return FAILED;
    }
    page = read.text;
  } else {
    if (tokensOf(job) > READ_LIMIT_TOKENS) {
      await failErrand(env.DB, row, { reason: 'too_long' });
      return FAILED;
    }
    page = job.trim();
  }

  // 2. The request: layers, the form's line, the skill, the page as data. No memory.
  let skill: { instruction: string } | null;
  try {
    skill = await readSkill(env, tokenId);
  } catch (e) {
    if (e instanceof SkillUnreadable) {
      console.log('skill_unreadable');
      await failErrand(env.DB, row, { reason: 'empty' });
      return FAILED;
    }
    throw e;
  }
  const today = utcDay(now);
  const life = await readLife(env.DB, tokenId);
  const layers: LifeLayers = { mood: moodOf(fullness(fs.eff).state, life.moodDay, today), energyPercent: energyLeft(life, today) * 10, outfit: await wornOf(env.DB, tokenId) };
  const { messages, pageBytes } = readMessages(pet, layers, skill?.instruction ?? null, link, page);
  // The page counts a token per four bytes (the limit's own measure); everything else a token per byte, an upper bound.
  const bound = inputBound(messages) - pageBytes + Math.ceil(pageBytes / 4);

  // 3. The ceiling: what the food, the cap and the thought's limit leave, the re-ask's 40 tokens set aside.
  const reaskMin = ceilingPrice(env, bound, EDGE_CEILING, false);
  if (fs.capLeft < minCallPrice(env, bound) + reaskMin) {
    await markTired(env.DB, tokenId, now);
    track('daily_cap_reached');
    await failErrand(env.DB, row, { reason: 'blocked' });
    return FAILED;
  }
  let plan = planOf(env, bound, fs, REPORT_FUSE, reaskMin);
  const planned = ceilingPrice(env, bound, plan.ceiling) + reaskMin;
  const reserve = need(env, 'read').yocto > planned ? need(env, 'read').yocto : planned;
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO pet_spend (token_id, reserve_yocto, job_id) VALUES (?, ?, ?)').bind(tokenId, reserve.toString(), null),
    env.DB.prepare("UPDATE errands SET reserve_yocto = ? WHERE token_id = ? AND id = ? AND state = 'away'").bind(reserve.toString(), tokenId, row.id),
  ]);

  try {
    // 4. The report, with reasoning; a reasoning that ate the ceiling gets one re-ask without it (≤ 600).
    const answers: Answer[] = [];
    const nonce = () => (skill === null ? {} : { extra: { nonce: hex(crypto.getRandomValues(new Uint8Array(16))) } });
    const first = await complete(env, { messages, maxTokens: plan.ceiling, thinking: true, timeoutMs: CHAT_TIMEOUT_MS, ...nonce() });
    const failure = await refusalOf(env, first, reserve);
    if (failure !== null) {
      // A pause of the services is a block; any other refusal is a report that did not come, nothing spent.
      await failErrand(env.DB, row, { reason: 'code' in failure && failure.code === 'paused' ? 'blocked' : 'empty' });
      return FAILED;
    }
    const a1 = first as Answer;
    answers.push(a1);
    let reply = replyOf(a1.content);
    let reasked = false;
    if (!hasVisible(reply) && a1.finishReason === 'length') {
      const second = reaskPlan(env, bound, fs, thoughtPrice(env, [{ tokensIn: a1.tokensIn, tokensOut: a1.tokensOut }]), REASK_FUSE);
      if (second !== null) {
        plan = second;
        const retry = await complete(env, { messages, maxTokens: second.ceiling, thinking: false, timeoutMs: CHAT_TIMEOUT_MS, ...nonce() });
        const bad = await refusalOf(env, retry, reserve, answers);
        if (bad !== null) {
          await failErrand(env.DB, row, { reason: 'code' in bad && bad.code === 'paused' ? 'blocked' : 'empty' });
          return FAILED;
        }
        answers.push(retry as Answer);
        reasked = true;
        reply = replyOf((retry as Answer).content);
      }
    }

    // 5. Every call needs its model signature before anything is shown.
    const calls: SignedCall[] = [];
    for (const answer of answers) {
      const signed = await signatureOf(env, answer);
      if (signed === null) {
        await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, answers)));
        console.log('signature_missing');
        await failErrand(env.DB, row, { reason: 'empty' });
        return FAILED;
      }
      calls.push({ answer, signed });
    }

    // 6. A report with no reply: free among the pet's first three empty answers of the UTC day, the pet's from the fourth.
    const captured = captureWorkNote(reply, answers[answers.length - 1]!.finishReason);
    reply = captured.report;
    const empty = !hasVisible(reply);
    if (empty) {
      const n = await countEmpty(env, tokenId, today);
      if (n <= FREE_EMPTY_ANSWERS) {
        await projectPays(env, 'no_thought', usd12ToMicros(callsUsd12(env, answers)));
        console.log('empty_free');
        await failErrand(env.DB, row, { reason: 'empty' });
        return FAILED;
      }
      console.log('empty_paid');
    }

    // 7. The price by usage, cut at the food, the cap and the thought's limit; the rest is the project's.
    const usage = thoughtPrice(env, answers.map((a) => ({ tokensIn: a.tokensIn, tokensOut: a.tokensOut })));
    const price = await cutPrice(env, fs, usage);
    const paid: Paid = { priceUsd: yoctoMicros(env, price) / 1e6, costUsd: tokensCostUsd(env, answers) };

    // 8. One batch: the errand ends first, and the thought is written only when that statement ended it (the 3 minutes
    // may have ended it already); the thought's calls follow it; a clear that landed meanwhile erases the words.
    const thoughtId = randomId();
    const sessionId = await openSession(env, tokenId, now);
    const skilled = skill !== null;
    const host = link === null ? null : new URL(link).hostname.replace(/^www\./, '');
    const sources = empty ? null : JSON.stringify(link === null ? [{ label: 'Your text' }] : [{ label: host, url: link }]);
    const cut = !empty && calls[calls.length - 1]!.answer.finishReason === 'length' ? plan.cutKind : null;
    const written = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE errands SET state = ?3, reason = ?4, thought_id = ?5, price_yocto = ?6, reserve_yocto = '0', searches_ran = 0,
             job = CASE WHEN ?3 = 'done' THEN NULL ELSE job END WHERE token_id = ?1 AND id = ?2 AND state = 'away' RETURNING id`,
        )
        .bind(tokenId, row.id, empty ? 'failed' : 'done', empty ? 'empty' : null, thoughtId, price.toString()),
      env.DB
        .prepare(
          `INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, cut, reasked, payer, session_id, status, skilled, recall, form, sources, verdict, searches, near_usd_rate, completed_errand)
           SELECT ?1, ?2, ?3, 'errand', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pet', ?11, 'unbilled', ?12, 0, 'read', ?13, NULL, 0, ?14, ?15
           WHERE EXISTS (SELECT 1 FROM errands WHERE token_id = ?2 AND thought_id = ?1)`,
        )
        .bind(thoughtId, tokenId, now, job, empty ? null : reply.trim(), env.MODEL_ID, price.toString(), yoctoMicros(env, price), cut, reasked ? 1 : 0, sessionId, skilled ? 1 : 0, sources, env.NEAR_USD_RATE, empty ? 0 : 1),
      ...calls.map(({ answer, signed }, n) =>
        env.DB
          .prepare(
            `INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut, label)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15 WHERE EXISTS (SELECT 1 FROM thoughts WHERE id = ?1)`,
          )
          .bind(
            thoughtId,
            n,
            // No request bytes for a skilled pet's report: only the hash (`Errand request data` › «a pet with a skill»).
            skilled ? new Uint8Array(0) : answer.reqBytes,
            answer.resBytes,
            answer.reqSha,
            answer.resSha,
            signed.signature,
            signed.sigKind,
            signed.signer,
            answer.id,
            answer.tokensIn,
            answer.tokensOut,
            answer.tokensReasoning,
            answer.finishReason === 'length' ? 1 : 0,
            n === 0 ? 'report' : 'reask',
          ),
      ),
      ...eraseIfCleared(env.DB, tokenId, thoughtId, epoch, now),
      ...stageNote(env.DB, { thoughtId, tokenId, note: empty ? null : captured.note, at: now, epoch, owner: pet.owner_id, generation: pet.transfer_generation }),
    ]);
    if ((written[0]?.results.length ?? 0) === 0) {
      // The 3 minutes ran out first: nothing of the report is stored and the pet pays nothing more.
      await projectPays(env, 'errand_late', usd12ToMicros(callsUsd12(env, answers)));
      console.log('errand_late');
      return { code: 'late' };
    }

    // 9. What a shown report does to the pet: the mood of the day, a counted day, a step of energy; no trait, no deed.
    const events = await afterThought(env, tokenId, pet, fs, { price, cut, shown: !empty, today, now });

    if (empty) {
      track('errand_failed', { form: 'read', reason: 'empty', searches: 0, price_usd: paid.priceUsd, cost_usd: paid.costUsd, cut: false, project_usd: 0 });
      track('thought_failed', { for: 'errand', payer: 'pet', cost_usd: paid.costUsd });
      return { code: 'empty_paid', events };
    }
    console.log('errand_ok:read:0');
    track('errand_reported', { form: 'read', searches: 0, sources: 1, latency_ms: Date.now() - row.sent_at, cut: false, project_usd: 0 });
    track('thought_delivered', { model: 'cheap', for: 'errand', price_usd: paid.priceUsd, cost_usd: paid.costUsd });
    // A clear that landed meanwhile: the report is not kept, its price is paid (`Errand flow` › «memory cleared on the way»).
    if (epoch !== (await memoryEpoch(env.DB, tokenId))) return { code: 'memory_cleared', events, price: price.toString() };
    return { thoughtId, cut, price: price.toString(), reasked, events };
  } finally {
    await env.DB.prepare('DELETE FROM pet_spend WHERE token_id = ?').bind(tokenId).run();
  }
}
