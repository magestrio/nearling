// «Find out» and «Is it true?» on the pet's desk (`Find out flow`, `Is it true flow`, `Errand request data`, `Errand
// price data`, ADR-026, ADR-027): one streamed search call that offers web search, the report from its results, one
// thought priced by usage. The search call holds the job's text and nothing else; the report holds the pet's layers
// and skill, the results as quoted data, never the pet's memory. Everything the pages and results say is hostile data.
import { type PetRecord } from '../chain';
import { utcDay } from '../http';
import { hasVisible } from '../name/clean';
import { complete, replyOf, signatureOf, streamCall, type SearchRan, type Signed, type StreamResult } from '../nearai';
import { eraseIfCleared, memoryEpoch } from '../pet/forget';
import { energyLeft, moodOf, readLife } from '../pet/life';
import { wornOf } from '../pet/outfits';
import { type FoodState } from '../pet/view';
import { ceilingFor, ceilingPrice, costUsd12, EDGE_CEILING, fullness, usd12ToMicros } from '../pricing';
import { errandDataMessages, inputBound, searchMessages, type LifeLayers } from '../prompt';
import { DATA_MAX_TOKENS, loadOffer, numbered, runDataStep, sourceLabelsOf, type Read } from '../sources/step';
import { CHAT_TIMEOUT_MS, countEmpty, FREE_EMPTY_ANSWERS, hex, openSession, projectPays, randomId, yoctoMicros, type Answer, type JobResult } from '../spend';
import { setPause } from '../servicePause';
import { track } from '../track';
import { readSkill, SkillUnreadable } from '../work/skill';
import { afterThought } from './after';
import { cutBoundUsd, cutPrice, errandPrice, REASK_FUSE, REPORT_FUSE, SEARCH_IN, SEARCH_OUT_BOUND, searchQuote } from './price';
import { numberResults, readReport, searchCallMessages, type Report } from './search';
import { announceFailed, failErrand, tokensCostUsd, type ErrandRow, type FailReason, type Paid } from './store';

const SEARCH_TIMEOUT_MS = 60_000;
const FAILED: JobResult = { code: 'errand_failed' };
type Form = 'find' | 'check';
type Finished = Extract<StreamResult, { kind: 'finished' }>;
type Cut = Extract<StreamResult, { kind: 'cut' }>;
type Tokens = { tokensIn: number; tokensOut: number };

interface Ctx {
  env: Env;
  tokenId: string;
  epoch: number;
  row: ErrandRow;
  form: Form;
  job: string;
  pet: PetRecord;
  fs: FoodState;
  layers: LifeLayers;
  skill: { instruction: string } | null;
  /** The reserve the sheet showed as «up to», and the searches the food pays and the allowance lets run. */
  upTo: bigint;
  allowed: number;
  now: number;
  today: number;
  /** What the project paid on this errand's search calls so far, USD (the events' `project_usd`). */
  projectUsd: number;
  /** The pet's skill has data sources or code: the allowance is 2 searches and a data step runs between the search and the report. */
  hasData: boolean;
  /** The data call, once signed: it sits on the receipt after the search call and its tokens are in the price. */
  dataCall: { answer: Answer; signed: Signed } | null;
  /** What the data step read, and the labels that did not answer (`data_labels`, `data_missed`). */
  reads: Read[];
  missed: Array<string | { code: true }>;
}

/** The project pays `usd12` and the events say so as `project_usd`. */
async function projectPaysSearch(c: Ctx, kind: string, usd12: bigint): Promise<void> {
  c.projectUsd += Number(usd12) / 1e12;
  await projectPays(c.env, kind, usd12ToMicros(usd12));
}

const tokensUsd12 = (env: Env, calls: Tokens[]): bigint => calls.reduce((sum, call) => sum + costUsd12(env, call.tokensIn, call.tokensOut), 0n);

export async function findErrand(env: Env, tokenId: string, epoch: number, row: ErrandRow, pet: PetRecord, fs: FoodState, hasData: boolean, now: number): Promise<JobResult> {
  const job = row.job!;
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
  const quote = searchQuote(env, fs.room, hasData);
  const upTo = quote.upTo.yocto;
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO pet_spend (token_id, reserve_yocto, job_id) VALUES (?, ?, ?)').bind(tokenId, upTo.toString(), null),
    env.DB.prepare("UPDATE errands SET reserve_yocto = ? WHERE token_id = ? AND id = ? AND state = 'away'").bind(upTo.toString(), tokenId, row.id),
  ]);
  const c: Ctx = { env, tokenId, epoch, row, form: row.form as Form, job, pet, fs, layers, skill, upTo, allowed: quote.searches, now, today, projectUsd: 0, hasData, dataCall: null, reads: [], missed: [] };
  try {
    return await searchAndReport(c);
  } finally {
    await env.DB.prepare('DELETE FROM pet_spend WHERE token_id = ?').bind(tokenId).run();
  }
}

async function searchAndReport(c: Ctx): Promise<JobResult> {
  const { env } = c;
  // The search call: one fixed server instruction and the job's text, the same for every pet — nothing of the pet's.
  const spec = { messages: searchCallMessages(c.job), maxTokens: SEARCH_OUT_BOUND, timeoutMs: SEARCH_TIMEOUT_MS, allowance: c.allowed };
  const noSearch: Finished[] = [];
  let call = await streamCall(env, spec);
  // A call that ran no search is sent once more, unseen (ADR-027): the repeat is the same request.
  if (call.kind === 'finished' && call.searches.length === 0) {
    noSearch.push(call);
    call = await streamCall(env, spec);
    if (call.kind === 'finished' && call.searches.length === 0) noSearch.push(call);
  }
  const lost = noSearch.length === 2 ? [] : noSearch;

  if (call.kind === 'finished' && call.searches.length === 0) return noSearchTwice(c, noSearch);

  // Whatever follows, a first call that ran no search is the project's.
  if (lost.length > 0) await projectPaysSearch(c, 'errand_no_search', tokensUsd12(env, lost));
  if (call.kind === 'paused') {
    await setPause(env.DB, 'ai', Date.now());
    await failErrand(env.DB, c.row, { reason: 'blocked', projectUsd: c.projectUsd });
    return FAILED;
  }
  if (call.kind === 'timeout' || call.kind === 'failed') {
    // Not reached: nothing is spent; a wait that ran out may still be billed, which the project bears.
    if (call.kind === 'timeout') {
      // An id can appear before the search runs; only a returned result proves its fee was incurred.
      const ran = call.searches.filter((search) => search.output !== null).length;
      const fee = BigInt(Math.round(Number(env.SEARCH_USD_PER_CALL) * 1e12));
      await projectPaysSearch(c, 'no_thought', costUsd12(env, SEARCH_IN[0], SEARCH_OUT_BOUND) + BigInt(ran) * fee);
    }
    else console.log(`ai_failed:${call.status}`);
    await failErrand(env.DB, c.row, { reason: 'search_down', cause: 'unreachable', projectUsd: c.projectUsd });
    return FAILED;
  }

  if (call.kind === 'cut') return afterCut(c, call);
  return reportFrom(c, call, await signatureOf(env, call, 'gateway'));
}

/** The model ran no search twice (ADR-027, OD-1891): among the pet's first three failed calls of the UTC day nothing is
 * spent; from the fourth the pet pays both calls by usage and the gas share, and their receipt is public. */
async function noSearchTwice(c: Ctx, calls: Finished[]): Promise<JobResult> {
  const { env } = c;
  const n = await countEmpty(env, c.tokenId, c.today);
  const free = async () => {
    await projectPaysSearch(c, 'errand_no_search', tokensUsd12(env, calls));
    await failErrand(env.DB, c.row, { reason: 'search_down', cause: 'no_search', projectUsd: c.projectUsd });
    return FAILED;
  };
  if (n <= FREE_EMPTY_ANSWERS) return free();
  const signed: Signed[] = [];
  for (const call of calls) {
    const one = await signatureOf(env, call, 'gateway');
    if (one === null) {
      console.log('signature_missing');
      return free();
    }
    signed.push(one);
  }
  const usage = errandPrice(env, calls, 0);
  const price = await cutPrice(env, c.fs, usage);
  const paid = paidOf(c, price, calls, 0);
  const thoughtId = randomId();
  const sessionId = await openSession(env, c.tokenId, c.now, c.row.shared_job_hash ?? undefined);
  const written = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE errands SET state = 'failed', reason = 'search_down', cause = 'no_search', thought_id = ?3, price_yocto = ?4, reserve_yocto = '0', searches_ran = 0
         WHERE token_id = ?1 AND id = ?2 AND state = 'away' RETURNING id`,
      )
      .bind(c.tokenId, c.row.id, thoughtId, price.toString()),
    thoughtInsert(c, thoughtId, sessionId, { status: 'unbilled', price, text: c.job, reply: null, searches: 0, sources: null, verdict: null, cut: null, reasked: false }),
    ...calls.map((call, n) => callInsert(c, thoughtId, call, signed[n]!, false, n)),
    ...eraseIfCleared(env.DB, c.tokenId, thoughtId, c.epoch, c.now),
  ]);
  if ((written[0]?.results.length ?? 0) === 0) {
    await projectPays(env, 'errand_late', usd12ToMicros(tokensUsd12(env, calls)));
    console.log('errand_late');
    return { code: 'late' };
  }
  const events = await afterThought(env, c.tokenId, c.pet, c.fs, { price, cut: null, shown: false, today: c.today, now: c.now });
  announceFailed(c.row, { reason: 'search_down', cause: 'no_search', searches: 0, paid, projectUsd: c.projectUsd });
  return { code: 'errand_failed', events };
}

/** A search past the allowance began and the stream was cut there (ADR-026). The searches whose results had arrived ran
 * and are the pet's; the cut call is unsigned, has no tokens and no price for the pet. */
async function afterCut(c: Ctx, call: Cut): Promise<JobResult> {
  const { env } = c;
  const ran = call.searches.filter((s) => s.output !== null).length;
  console.log(`search_over:${call.searches.length}`);
  await projectPaysSearch(c, 'errand_cut', BigInt(Math.round(cutBoundUsd(env, Math.max(ran, 1)) * 1e12)));
  if (ran === 0) {
    // Nothing came back to report on: as an unreachable search, nothing spent.
    await failErrand(env.DB, c.row, { reason: 'search_down', cause: 'unreachable', cut: true, projectUsd: c.projectUsd });
    return FAILED;
  }
  return reportFrom(c, call, { signature: '', sigKind: 'gateway', signer: '' });
}

/** The searches that ran are stored with their call, then the report is written from their results. `signed` is null
 * when NEAR AI would not sign the search call: nobody can prove it, the project pays and nothing is shown. */
async function reportFrom(c: Ctx, call: Finished | Cut, signed: Signed | null): Promise<JobResult> {
  const { env } = c;
  const cut = call.kind === 'cut';
  const searches: SearchRan[] = cut ? call.searches.filter((s) => s.output !== null) : call.searches;
  const ran = searches.length;
  const searchTokens: Tokens[] = call.kind === 'finished' ? [call] : [];
  if (signed === null) {
    console.log('signature_missing');
    await projectPaysSearch(c, 'no_thought', tokensUsd12(env, searchTokens) + BigInt(ran) * BigInt(Math.round(Number(env.SEARCH_USD_PER_CALL) * 1e12)));
    await failErrand(env.DB, c.row, { reason: 'empty', projectUsd: c.projectUsd });
    return FAILED;
  }

  // 1. The search call is stored as soon as it is signed, status `away`, so a timeout can bill what ran.
  const thoughtId = randomId();
  const sessionId = await openSession(env, c.tokenId, c.now, c.row.shared_job_hash ?? undefined);
  const stored = await env.DB.batch([
    env.DB.prepare("UPDATE errands SET thought_id = ?3, searches_ran = ?4 WHERE token_id = ?1 AND id = ?2 AND state = 'away' RETURNING id").bind(c.tokenId, c.row.id, thoughtId, ran),
    thoughtInsert(c, thoughtId, sessionId, { status: 'away', price: 0n, text: null, reply: null, searches: ran, sources: null, verdict: null, cut: null, reasked: false }),
    callInsert(c, thoughtId, call, signed, cut),
    ...eraseIfCleared(env.DB, c.tokenId, thoughtId, c.epoch, c.now),
  ]);
  if ((stored[0]?.results.length ?? 0) === 0) return late(c, [], searchTokens, ran);

  const stillAway = async () => (await env.DB.prepare("SELECT 1 AS away FROM errands WHERE token_id = ? AND id = ? AND state = 'away'").bind(c.tokenId, c.row.id).first()) !== null;
  if (!(await stillAway())) return late(c, [], [], 0);

  // 2. The data step, between the search and the report (a pet whose skill has data sources or code): the data call is
  // one more call of the thought, its tokens in the price; what the tools brought goes to the report as quoted data.
  await dataStep(c, searchTokens, ran);
  if (c.dataCall !== null) searchTokens.push(c.dataCall.answer);
  if (!(await stillAway())) return late(c, [], c.dataCall === null ? [] : [c.dataCall.answer], 0);

  // 3. The report. Its input holds the results, numbered and bounded, and the data read, as quoted data.
  const items = numberResults(searches);
  const thinking = ran < 3;
  const { messages, resultsBytes } = searchMessages(c.pet, c.layers, thinking, c.skill?.instruction ?? null, c.form, c.job, items, numbered(c.reads, items.length + 1));
  const bound = inputBound(messages) - resultsBytes + Math.ceil(resultsBytes / 4);
  const ceilingOf = (spent: bigint, fuse: number) => Math.max(EDGE_CEILING, ceilingFor(env, bound, c.upTo - spent, fuse, false));
  const nonce = () => (c.skill === null ? {} : { extra: { nonce: hex(crypto.getRandomValues(new Uint8Array(16))) } });

  const answers: Answer[] = [];
  let ceiling = ceilingOf(errandPrice(env, searchTokens, ran), REPORT_FUSE);
  const first = await complete(env, { messages, maxTokens: ceiling, thinking, timeoutMs: CHAT_TIMEOUT_MS, ...nonce() });
  let broken = await broke(c, first, bound, ceiling, []);
  let reply = '';
  let reasked = false;
  if (!broken) {
    const a1 = first as Answer;
    answers.push(a1);
    reply = replyOf(a1.content);
    // A reasoning that ate the ceiling left no reply: one re-ask without it (≤ 600), never after three searches.
    if (!hasVisible(readReport(reply, items, c.form).text) && a1.finishReason === 'length' && thinking) {
      const room = ceilingFor(env, bound, c.upTo - errandPrice(env, [...searchTokens, a1], ran), REASK_FUSE, false);
      if (room >= 1) {
        ceiling = room;
        const retry = await complete(env, { messages, maxTokens: room, thinking: false, timeoutMs: CHAT_TIMEOUT_MS, ...nonce() });
        broken = await broke(c, retry, bound, room, answers);
        if (!broken) {
          answers.push(retry as Answer);
          reasked = true;
          reply = replyOf((retry as Answer).content);
        }
      }
    }
  }

  // 3. Every report call needs its model signature before anything is shown.
  const signedReport: { answer: Answer; signed: Signed }[] = [];
  if (!broken) {
    for (const answer of answers) {
      const one = await signatureOf(env, answer);
      if (one === null) {
        console.log('signature_missing');
        await projectPaysSearch(c, 'no_thought', tokensUsd12(env, answers));
        broken = true;
        break;
      }
      signedReport.push({ answer, signed: one });
    }
  }

  // 4. A report that did not come: the pet pays the searches that ran, whatever happened to the report.
  if (broken) return came(c, thoughtId, searchTokens, ran, [], 'empty', cut);
  const report = readReport(reply, items, c.form);
  if (!hasVisible(report.text)) {
    // An empty report is free among the pet's first three failed calls of the UTC day, the pet's own from the fourth.
    const n = await countEmpty(env, c.tokenId, c.today);
    if (n <= FREE_EMPTY_ANSWERS) {
      await projectPays(env, 'no_thought', usd12ToMicros(tokensUsd12(env, answers)));
      console.log('empty_free');
      return came(c, thoughtId, searchTokens, ran, [], 'empty', cut);
    }
    console.log('empty_paid');
    return came(c, thoughtId, searchTokens, ran, signedReport, 'empty', cut);
  }
  return shown(c, thoughtId, searchTokens, ran, signedReport, report, reasked, ceiling, cut);
}

/** The data step of a pet whose skill has data sources or code (`Errand request data`, `Adapter call rule` › «data failed in
 * an errand»): the data call, then the tools it asked for. A call that did not come, or one the services' pause stopped, is
 * a report that goes on without data; a source or function that failed is named in `missed`. */
async function dataStep(c: Ctx, before: Tokens[], ran: number): Promise<void> {
  if (!c.hasData) return;
  const { env } = c;
  const offer = await loadOffer(env, c.tokenId);
  if (offer === null) return;
  const messages = errandDataMessages(c.pet, c.layers, c.skill?.instruction ?? null, c.form, c.job);
  const bound = inputBound(messages) + offer.toolsBytes;
  // The data call fits what is left under the «up to» the sheet showed.
  const maxTokens = ceilingFor(env, bound, c.upTo - errandPrice(env, before, ran), DATA_MAX_TOKENS, false);
  if (maxTokens < 1) return;
  const step = await runDataStep(env, offer, { tokenId: c.tokenId, job: 'errand', messages, maxTokens, bound });
  if (step.kind === 'paused') {
    await setPause(env.DB, 'ai', Date.now());
    console.log('ai_402');
    return;
  }
  if (step.kind === 'lost') return;
  c.dataCall = step.call;
  c.reads = step.reads;
  c.missed = [...step.failedSources, ...(step.codeFailed ? [{ code: true as const }] : [])];
}

/** A report call that is not an answer: a pause of the services is noted, the project pays what a call it cannot see
 * may have cost. True when the report did not come. */
async function broke(c: Ctx, result: Awaited<ReturnType<typeof complete>>, bound: number, ceiling: number, earlier: Answer[]): Promise<boolean> {
  if (result.kind === 'answer') return false;
  if (earlier.length > 0) await projectPays(c.env, 'no_thought', usd12ToMicros(tokensUsd12(c.env, earlier)));
  if (result.kind === 'paused') {
    await setPause(c.env.DB, 'ai', Date.now());
    console.log('ai_402');
  } else if (result.kind === 'timeout') {
    await projectPays(c.env, 'no_thought', yoctoMicros(c.env, ceilingPrice(c.env, bound, ceiling)));
    console.log('ai_timeout');
  } else {
    console.log(`ai_failed:${result.status}`);
  }
  return true;
}

/** What the pet paid, in USD at the rate it was made, and what the project spent for it: tokens and each search fee. */
function paidOf(c: Ctx, price: bigint, calls: Tokens[], ran: number): Paid {
  return { priceUsd: yoctoMicros(c.env, price) / 1e6, costUsd: tokensCostUsd(c.env, calls) + ran * Number(c.env.SEARCH_USD_PER_CALL) };
}

/** The errand's job ended after the 3 minutes did: nothing is stored, the pet pays nothing more, the project the calls. */
async function late(c: Ctx, report: Answer[], unpaidCalls: Tokens[], unpaidSearches: number): Promise<JobResult> {
  const usd12 = tokensUsd12(c.env, [...unpaidCalls, ...report]) + BigInt(unpaidSearches) * BigInt(Math.round(Number(c.env.SEARCH_USD_PER_CALL) * 1e12));
  await projectPays(c.env, 'errand_late', usd12ToMicros(usd12));
  console.log('errand_late');
  return { code: 'late' };
}

/** The receipt's rows: the thought, then the calls. `status` `away` waits for its report; `unbilled` goes to the batch. */
interface ThoughtFields {
  status: 'away' | 'unbilled';
  price: bigint;
  text: string | null;
  reply: string | null;
  searches: number;
  sources: string | null;
  verdict: string | null;
  cut: string | null;
  reasked: boolean;
}

function thoughtInsert(c: Ctx, id: string, sessionId: string, f: ThoughtFields): D1PreparedStatement {
  return c.env.DB
    .prepare(
      `INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, cut, reasked, payer, session_id, status, skilled, recall, form, sources, verdict, searches, near_usd_rate, shared_job_hash)
       SELECT ?1, ?2, ?3, 'errand', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pet', ?11, ?12, ?13, 0, ?14, ?15, ?16, ?17, ?18, ?19
       WHERE EXISTS (SELECT 1 FROM errands WHERE token_id = ?2 AND thought_id = ?1)`,
    )
    .bind(id, c.tokenId, c.now, f.text, f.reply, c.env.MODEL_ID, f.price.toString(), yoctoMicros(c.env, f.price), f.cut, f.reasked ? 1 : 0, sessionId, f.status, c.skill === null ? 0 : 1, c.form, f.sources, f.verdict, f.searches, c.env.NEAR_USD_RATE, c.row.shared_job_hash ?? null);
}

/** The search call's row: its bytes are kept (it holds only the job). A cut call is unsigned, has no tokens, and is
 * marked cut. */
function callInsert(c: Ctx, thoughtId: string, call: Finished | Cut, signed: Signed, cut: boolean, n = 0): D1PreparedStatement {
  const usage = call.kind === 'finished' ? call : { tokensIn: 0, tokensOut: 0, tokensReasoning: 0 };
  return c.env.DB
    .prepare(
      `INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut, label)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'search' WHERE EXISTS (SELECT 1 FROM thoughts WHERE id = ?1)`,
    )
    .bind(thoughtId, n, call.reqBytes, call.resBytes, call.reqSha, call.resSha, signed.signature, signed.sigKind, signed.signer, call.id ?? '', usage.tokensIn, usage.tokensOut, usage.tokensReasoning, cut ? 1 : 0);
}

/** A report that did not come, or came empty: the thought of the searches turns `unbilled` with the searches' price
 * (and the report's tokens when the pet pays them), and the errand is kept as «came back empty». */
async function came(
  c: Ctx,
  thoughtId: string,
  searchTokens: Tokens[],
  ran: number,
  report: { answer: Answer; signed: Signed }[],
  reason: FailReason,
  cut: boolean,
): Promise<JobResult> {
  const paidCalls = [...searchTokens, ...report.map((r) => r.answer)];
  const price = await cutPrice(c.env, c.fs, errandPrice(c.env, paidCalls, ran));
  const sessionId = await openSession(c.env, c.tokenId, c.now, c.row.shared_job_hash ?? undefined);
  const landed = await land(c, thoughtId, {
    state: 'failed',
    reason,
    price,
    sessionId,
    report,
    fields: { status: 'unbilled', price, text: c.job, reply: null, searches: ran, sources: null, verdict: null, cut: null, reasked: report.length > 1 },
  });
  if (!landed) return late(c, report.map((r) => r.answer), c.dataCall === null ? [] : [c.dataCall.answer], 0);
  const paid = paidOf(c, price, paidCalls, ran);
  const events = await afterThought(c.env, c.tokenId, c.pet, c.fs, { price, cut: null, shown: false, today: c.today, now: c.now });
  announceFailed(c.row, { reason, searches: ran, paid, cut, projectUsd: c.projectUsd });
  if (report.length > 0) track('thought_failed', { for: 'errand', payer: 'pet', cost_usd: tokensCostUsd(c.env, report.map((r) => r.answer)) });
  return { code: 'errand_failed', events };
}

/** The report is shown: the thought turns `unbilled` with its words, sources and verdict; the pet's price is by usage. */
async function shown(
  c: Ctx,
  thoughtId: string,
  searchTokens: Tokens[],
  ran: number,
  report: { answer: Answer; signed: Signed }[],
  text: Report,
  reasked: boolean,
  ceiling: number,
  cut: boolean,
): Promise<JobResult> {
  const answers = report.map((r) => r.answer);
  const price = await cutPrice(c.env, c.fs, errandPrice(c.env, [...searchTokens, ...answers], ran));
  const sessionId = await openSession(c.env, c.tokenId, c.now, c.row.shared_job_hash ?? undefined);
  const last = answers[answers.length - 1]!;
  const reportCut = last.finishReason === 'length' ? (ceiling < (reasked ? REASK_FUSE : REPORT_FUSE) ? 'food' : 'fuse') : null;
  const landed = await land(c, thoughtId, {
    state: 'done',
    reason: null,
    price,
    sessionId,
    report,
    fields: { status: 'unbilled', price, text: c.job, reply: text.text, searches: ran, sources: JSON.stringify(text.sources), verdict: text.verdict, cut: reportCut, reasked },
  });
  if (!landed) return late(c, answers, c.dataCall === null ? [] : [c.dataCall.answer], 0);
  const paid = paidOf(c, price, [...searchTokens, ...answers], ran);
  const events = await afterThought(c.env, c.tokenId, c.pet, c.fs, { price, cut: reportCut, shown: true, today: c.today, now: c.now });
  console.log(`errand_ok:${c.form}:${ran}`);
  track('errand_reported', { form: c.form, searches: ran, sources: text.sources.length, latency_ms: Date.now() - c.row.sent_at, cut, project_usd: c.projectUsd });
  track('thought_delivered', { model: 'cheap', for: 'errand', price_usd: paid.priceUsd, cost_usd: paid.costUsd });
  // A clear that landed meanwhile: the report is not kept, its price is paid (`Errand flow` › «memory cleared on the way»).
  if (c.epoch !== (await memoryEpoch(c.env.DB, c.tokenId))) return { code: 'memory_cleared', events, price: price.toString() };
  return { thoughtId, cut: reportCut, price: price.toString(), reasked, events };
}

const labelsJson = (labels: ReadonlyArray<string | { code: true }>): string | null => (labels.length === 0 ? null : JSON.stringify(labels));

/** The end of the errand and of its thought, in one batch: the errand row first and only when it is still away, then
 * the thought and the report's calls only when that statement ended it (the 3 minutes may have ended it already). */
async function land(
  c: Ctx,
  thoughtId: string,
  a: { state: 'done' | 'failed'; reason: FailReason | null; price: bigint; sessionId: string; report: { answer: Answer; signed: Signed }[]; fields: ThoughtFields },
): Promise<boolean> {
  const { env } = c;
  const mine = `EXISTS (SELECT 1 FROM errands WHERE token_id = ?1 AND thought_id = ?2 AND state = ?3 AND reason IS ?4)`;
  const written = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE errands SET state = ?3, reason = ?4, price_yocto = ?5, reserve_yocto = '0', job = CASE WHEN ?3 = 'done' THEN NULL ELSE job END
         WHERE token_id = ?1 AND id = ?2 AND state = 'away' RETURNING id`,
      )
      .bind(c.tokenId, c.row.id, a.state, a.reason, a.price.toString()),
    env.DB
      .prepare(
        `UPDATE thoughts SET player_text = ?5, reply_text = ?6, price_yocto = ?7, price_usd_micros = ?8, cut = ?9, reasked = ?10, session_id = ?11, status = 'unbilled', sources = ?12, verdict = ?13, searches = ?14, data_labels = ?15, data_missed = ?16, near_usd_rate = ?17
         WHERE id = ?2 AND status = 'away' AND ${mine}`,
      )
      .bind(
        c.tokenId,
        thoughtId,
        a.state,
        a.reason,
        a.fields.text,
        a.fields.reply,
        a.price.toString(),
        yoctoMicros(env, a.price),
        a.fields.cut,
        a.fields.reasked ? 1 : 0,
        a.sessionId,
        a.fields.sources,
        a.fields.verdict,
        a.fields.searches,
        labelsJson(sourceLabelsOf(c.reads)),
        labelsJson(c.missed),
        env.NEAR_USD_RATE,
      ),
    // After the search call (n = 0): the data call, when one was made, then the report and its re-ask.
    ...[
      ...(c.dataCall === null ? [] : [{ ...c.dataCall, label: 'data' }]),
      ...a.report.map((r, i) => ({ ...r, label: i === 0 ? 'report' : 'reask' })),
    ].map(({ answer, signed, label }, i) =>
      env.DB
        .prepare(
          `INSERT INTO thought_calls (thought_id, n, req_bytes, res_bytes, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut, label)
           SELECT ?2, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18 WHERE ${mine}`,
        )
        .bind(
          c.tokenId,
          thoughtId,
          a.state,
          a.reason,
          i + 1,
          c.skill !== null ? new Uint8Array(0) : answer.reqBytes,
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
          label,
        ),
    ),
    ...eraseIfCleared(env.DB, c.tokenId, thoughtId, c.epoch, c.now),
  ]);
  return (written[0]?.results.length ?? 0) > 0;
}
