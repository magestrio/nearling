import { decodeSignedTransaction } from 'near-api-js';
import { ChainUnreachable, petKnows, petView, sendSigned, txHashOf, txStatus, type PetRecord } from '../chain';
import { gasFor } from '../debit';
import { utcDay } from '../http';
import { complete, replyOf, signatureOf, type CallResult } from '../nearai';
import { memoryEpoch } from '../pet/forget';
import { energyLeft, moodOf, readLife } from '../pet/life';
import { wornOf } from '../pet/outfits';
import { foodState } from '../pet/view';
import { ceilingFor, costUsd12, FUSE_CHAT, fullness, MAX_THOUGHT_PRICE_YOCTO, minCallPrice, nearUsdRate, thoughtPrice, usd12ToMicros, yoctoToUsdMicros } from '../pricing';
import { gasIsLow, isPaused } from '../servicePause';
import { projectPays } from '../spend';
import { relation } from '../society/relations';
import { parseReaction } from '../society/reaction';
import { matchingDebateReceipt } from '../verification/receipt';
import { track } from '../track';
import { recordDebateEvent } from './events';
import { applyDebateOutcome, settlePendingDebateOutcomes } from './outcome';
import { debateMessages, debateRefusal } from './prompt';

const LEASE_MS = 3 * 60_000;
const DEBATE_DAY_CAP = 10_000_000_000_000_000_000_000n;
const MIN_LINE = 40;

interface Debate {
  id: string;
  first_pet: string;
  second_pet: string;
  first_owner: string;
  second_owner: string;
  first_generation: number;
  second_generation: number;
  first_epoch: number;
  second_epoch: number;
  acquaintance: 'first_fed' | 'second_fed' | 'hire';
  opener_pet: string;
  topic: string;
  status: string;
  lease_until: number | null;
}

interface Line {
  line_order: number;
  speaker_pet: string;
  status: string;
  text: string | null;
  request_bytes: string | null;
  response_bytes: string | null;
  signed_call: string | null;
  price_yocto: string | null;
  near_usd_rate: string | null;
  receipt_tx_hash: string | null;
  settled_at: number | null;
}

interface Operation {
  operation_id: string;
  debit_id: number | null;
  args_json: string | null;
  tx_hash: string | null;
  signed_tx: ArrayBuffer | null;
  status: string;
}

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function current(env: Env, row: Debate): Promise<[PetRecord, PetRecord] | null> {
  const [first, second, firstEpoch, secondEpoch] = await Promise.all([
    petView(env, row.first_pet), petView(env, row.second_pet),
    memoryEpoch(env.DB, row.first_pet), memoryEpoch(env.DB, row.second_pet),
  ]);
  if (first === null || second === null || firstEpoch !== row.first_epoch || secondEpoch !== row.second_epoch) return null;
  if (first.owner_id !== row.first_owner || second.owner_id !== row.second_owner ||
      first.transfer_generation !== row.first_generation || second.transfer_generation !== row.second_generation) return null;
  const known = row.acquaintance === 'hire'
    ? first.work_known?.includes(row.second_pet) || second.work_known?.includes(row.first_pet)
    : row.acquaintance === 'first_fed'
      ? await petKnows(env, row.first_pet, row.second_owner)
      : await petKnows(env, row.second_pet, row.first_owner);
  return known ? [first, second] : null;
}

async function end(env: Env, row: Debate, status: string, reason: string, now: number): Promise<void> {
  const ended = await env.DB.prepare(`UPDATE debates SET status = ?, end_reason = ?, ended_at = ?, lease_until = NULL
    WHERE id = ? AND status IN ('accepted', 'running')`).bind(status, reason, now, row.id).run();
  await env.DB.prepare("DELETE FROM debate_lines WHERE debate_id = ? AND status = 'pending'").bind(row.id).run();
  await env.DB.prepare(`DELETE FROM debate_lines WHERE debate_id = ? AND status = 'receipt_pending'
    AND NOT EXISTS (SELECT 1 FROM debate_debit_operations op WHERE op.debate_id = debate_lines.debate_id
      AND op.line_order = debate_lines.line_order AND op.tx_hash IS NOT NULL)`).bind(row.id).run();
  if (ended.meta.changes === 1) await recordDebateEvent(env, { name: 'debate_ended', id: row.id,
    firstPet: row.first_pet, secondPet: row.second_pet, reason: 'unavailable', at: now });
}

async function claimDays(env: Env, row: Debate, now: number): Promise<boolean> {
  const day = utcDay(now);
  const first = await env.DB.prepare('SELECT debate_id FROM debate_started_days WHERE pet_id = ? AND day = ?')
    .bind(row.first_pet, day).first<{ debate_id: string }>();
  const second = await env.DB.prepare('SELECT debate_id FROM debate_started_days WHERE pet_id = ? AND day = ?')
    .bind(row.second_pet, day).first<{ debate_id: string }>();
  if ((first !== null && first.debate_id !== row.id) || (second !== null && second.debate_id !== row.id)) return false;
  if (row.status === 'accepted' && (first !== null || second !== null)) return false;
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO debate_started_days (pet_id, day, debate_id)
        SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM debate_started_days WHERE pet_id = ? AND day = ?)
          AND EXISTS (SELECT 1 FROM debates WHERE id = ? AND status IN ('accepted', 'running'))`)
        .bind(row.first_pet, day, row.id, row.first_pet, day, row.id),
      env.DB.prepare(`INSERT INTO debate_started_days (pet_id, day, debate_id)
        SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM debate_started_days WHERE pet_id = ? AND day = ?)
          AND EXISTS (SELECT 1 FROM debates WHERE id = ? AND status IN ('accepted', 'running'))`)
        .bind(row.second_pet, day, row.id, row.second_pet, day, row.id),
      env.DB.prepare("UPDATE debates SET status = 'running' WHERE id = ? AND status IN ('accepted', 'running')").bind(row.id),
    ]);
    if (result[2]!.meta.changes !== 1) return false;
    const [a, b] = await Promise.all([
      env.DB.prepare('SELECT debate_id FROM debate_started_days WHERE pet_id = ? AND day = ?').bind(row.first_pet, day).first<{ debate_id: string }>(),
      env.DB.prepare('SELECT debate_id FROM debate_started_days WHERE pet_id = ? AND day = ?').bind(row.second_pet, day).first<{ debate_id: string }>(),
    ]);
    return a?.debate_id === row.id && b?.debate_id === row.id;
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: debate_started_days')) return false;
    throw error;
  }
}

async function settled(env: Env, row: Debate, line: Line, op: Operation, now: number): Promise<void> {
  if (op.tx_hash === null || !await matchingDebateReceipt(env, row.id, line.line_order, line.speaker_pet, line.price_yocto ?? '',
    line.signed_call ?? '', op.tx_hash)) {
    await env.DB.prepare("UPDATE debate_debit_operations SET status = 'unknown' WHERE debate_id = ? AND line_order = ? AND operation_id = ?")
      .bind(row.id, line.line_order, op.operation_id).run();
    return;
  }
  // A call begun yesterday can settle after midnight. Its debate owns today's slot too.
  const active = await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(row.id).first<{ status: string }>();
  if (active?.status === 'running' && !await claimDays(env, { ...row, status: 'running' }, now))
    throw new Error('debate_carried_slot_conflict');
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE debate_debit_operations SET status = 'accepted' WHERE debate_id = ? AND line_order = ? AND operation_id = ? AND status IN ('sending', 'unknown')")
      .bind(row.id, line.line_order, op.operation_id),
    env.DB.prepare(`UPDATE debate_lines SET status = 'settled', receipt_tx_hash = ?, settled_at = ?
      WHERE debate_id = ? AND line_order = ? AND status = 'receipt_pending'`).bind(op.tx_hash, now, row.id, line.line_order),
    env.DB.prepare(`UPDATE debates SET status = ?, end_reason = ?, ended_at = ?, lease_until = NULL
      WHERE id = ? AND status = 'running'`).bind(line.line_order === 4 ? 'completed' : debateRefusal(line.text ?? '', line.line_order) ? 'refused' : 'running',
      line.line_order === 4 ? 'complete' : debateRefusal(line.text ?? '', line.line_order) ? 'refused' : null,
      line.line_order === 4 || debateRefusal(line.text ?? '', line.line_order) ? now : null, row.id),
  ]);
  if (result[1]!.meta.changes === 1) {
    const call = JSON.parse(line.signed_call ?? '') as { tokens_in: number; tokens_out: number };
    const rate = nearUsdRate(line.near_usd_rate ?? '');
    if (rate === null) throw new Error('rate_missing');
    const priceUsd = yoctoToUsdMicros(BigInt(line.price_yocto ?? '0'), rate) / 1_000_000;
    const costUsd = usd12ToMicros(costUsd12(env, call.tokens_in, call.tokens_out)) / 1_000_000;
    await recordDebateEvent(env, { name: 'debate_line_delivered', id: row.id, firstPet: row.first_pet,
      secondPet: row.second_pet, speakerPet: line.speaker_pet, order: line.line_order, priceUsd, costUsd, at: now });
    track('thought_delivered', { model: 'cheap', for: 'debate', price_usd: priceUsd, cost_usd: costUsd });
    if (line.line_order === 4 || debateRefusal(line.text ?? '', line.line_order))
      await recordDebateEvent(env, { name: 'debate_ended', id: row.id, firstPet: row.first_pet,
        secondPet: row.second_pet, reason: line.line_order === 4 ? 'complete' : 'refused', at: now });
  }
  if (line.line_order === 4) await applyDebateOutcome(env, row.id, now);
}

async function rejected(env: Env, row: Debate, line: Line, op: Operation, now: number): Promise<void> {
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE debate_debit_operations SET status = 'rejected' WHERE debate_id = ? AND line_order = ? AND operation_id = ?")
      .bind(row.id, line.line_order, op.operation_id),
    env.DB.prepare("UPDATE debate_lines SET status = 'unavailable' WHERE debate_id = ? AND line_order = ? AND status = 'receipt_pending'")
      .bind(row.id, line.line_order),
    env.DB.prepare("UPDATE debates SET status = 'unavailable', end_reason = 'debit_rejected', ended_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'")
      .bind(now, row.id),
  ]);
  if (result[2]!.meta.changes === 1) await recordDebateEvent(env, { name: 'debate_ended', id: row.id,
    firstPet: row.first_pet, secondPet: row.second_pet, reason: 'unavailable', at: now });
  if (result[1]!.meta.changes === 1) {
    const call = JSON.parse(line.signed_call ?? '') as { tokens_in: number; tokens_out: number };
    track('thought_failed', { for: 'debate', reason: 'debit_rejected',
      cost_usd: usd12ToMicros(costUsd12(env, call.tokens_in, call.tokens_out)) / 1_000_000 });
  }
}

async function cancelledAfterGift(env: Env, row: Debate, line: Line): Promise<void> {
  const call = JSON.parse(line.signed_call ?? '') as { tokens_in: number; tokens_out: number };
  if (!Number.isSafeInteger(call.tokens_in) || !Number.isSafeInteger(call.tokens_out)) throw new Error('bad_debate_call');
  const cost = usd12ToMicros(costUsd12(env, call.tokens_in, call.tokens_out));
  // Charge the project and remove its unpublished line in one D1 batch. The existence guard
  // keeps a second reconciliation from counting the call twice.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO project_spend (at, kind, usd_micros)
      SELECT ?, 'debate_cancelled', ? WHERE EXISTS
      (SELECT 1 FROM debate_lines WHERE debate_id = ? AND line_order = ? AND status = 'receipt_pending')`)
      .bind(Date.now(), cost, row.id, line.line_order),
    env.DB.prepare("DELETE FROM debate_lines WHERE debate_id = ? AND line_order = ? AND status = 'receipt_pending'")
      .bind(row.id, line.line_order),
  ]);
  if (result[0]!.meta.changes === 1) track('thought_failed', { for: 'debate', reason: 'gift', cost_usd: cost / 1_000_000 });
  await end(env, row, 'gift', 'gift', Date.now());
}

async function recover(env: Env, row: Debate, line: Line, now: number): Promise<void> {
  const op = await env.DB.prepare('SELECT * FROM debate_debit_operations WHERE debate_id = ? AND line_order = ?')
    .bind(row.id, line.line_order).first<Operation>();
  if (op === null) { await end(env, row, 'unavailable', 'debit_rejected', now); return; }
  if (op.status === 'accepted' || op.status === 'rejected') return;
  if (op.tx_hash === null) {
    if (row.status === 'gift' || await current(env, row) === null) { await cancelledAfterGift(env, row, line); return; }
    if (op.args_json === null || op.debit_id === null) return;
    let args: Record<string, unknown>;
    try { args = JSON.parse(op.args_json) as Record<string, unknown>; } catch { return; }
    const sent = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'debit_session', args, gas: gasFor(1),
      writes: { kind: 'debate_debit', debateId: row.id, lineOrder: line.line_order, operationId: op.operation_id },
    });
    const saved = await env.DB.prepare('SELECT * FROM debate_debit_operations WHERE debate_id = ? AND line_order = ?')
      .bind(row.id, line.line_order).first<Operation>();
    if (saved?.tx_hash !== null && saved !== null) {
      if (sent.status === 'ok') await settled(env, row, line, saved, now);
      else if (sent.status === 'failed' && sent.code === 'gift_version_changed') await cancelledAfterGift(env, row, line);
      else if (sent.status === 'failed') await rejected(env, row, line, saved, now);
    }
    return;
  }
  const outcome = await txStatus(env, op.tx_hash, env.SERVER_ACCOUNT_ID);
  if (outcome?.status === 'ok') await settled(env, row, line, op, now);
  else if (outcome?.status === 'failed' && outcome.code === 'gift_version_changed') await cancelledAfterGift(env, row, line);
  else if (outcome?.status === 'failed') await rejected(env, row, line, op, now);
  else {
    // A lost answer or broadcast is retried with the very same signed bytes and hash.
    // Never create another debit operation while this outcome is unknown.
    if (op.signed_tx !== null) {
      try {
        const signed = decodeSignedTransaction(new Uint8Array(op.signed_tx));
        if (signed.transaction.signerId === env.SERVER_ACCOUNT_ID && await txHashOf(signed) === op.tx_hash) {
          const resent = await sendSigned(env, signed);
          if (resent.status === 'ok') { await settled(env, row, line, op, now); return; }
          if (resent.status === 'failed' && resent.code === 'gift_version_changed') { await cancelledAfterGift(env, row, line); return; }
          if (resent.status === 'failed' && resent.code !== 'invalid_nonce') { await rejected(env, row, line, op, now); return; }
        }
      } catch { /* A corrupt copy cannot authorize a new transaction. Keep the original hash pending. */ }
    }
    await env.DB.prepare("UPDATE debate_debit_operations SET status = 'unknown' WHERE debate_id = ? AND line_order = ? AND status = 'sending'")
      .bind(row.id, line.line_order).run();
  }
}

async function oneTurn(env: Env, row: Debate, now: number): Promise<void> {
  const lines = (await env.DB.prepare('SELECT * FROM debate_lines WHERE debate_id = ? ORDER BY line_order').bind(row.id).all<Line>()).results;
  const last = lines.at(-1);
  if (last?.status === 'receipt_pending') { await recover(env, row, last, now); return; }
  if (last?.status === 'pending') await env.DB.prepare("DELETE FROM debate_lines WHERE debate_id = ? AND line_order = ? AND status = 'pending'").bind(row.id, last.line_order).run();
  const order = (last?.line_order ?? 0) + 1;
  if (order > 4 || (last !== undefined && last.status !== 'settled' && last.status !== 'pending')) return;
  const pets = await current(env, row);
  if (pets === null) { await end(env, row, 'gift', 'gift', now); return; }
  const speakerId = order % 2 === 1 ? row.opener_pet : row.opener_pet === row.first_pet ? row.second_pet : row.first_pet;
  const speaker = speakerId === row.first_pet ? pets[0] : pets[1];
  if (await isPaused(env.DB, 'thought') || await gasIsLow(env, now)) {
    await end(env, row, 'unavailable', 'services_paused', now); return;
  }
  const fs = await foodState(env.DB, speakerId, speaker, now);
  if (fs.eff <= 0n) { await end(env, row, 'unavailable', 'asleep', now); return; }
  const spent = lines.filter((line) => line.speaker_pet === speakerId && line.status === 'settled' &&
    line.settled_at !== null && utcDay(line.settled_at) === utcDay(now))
    .reduce((total, line) => total + BigInt(line.price_yocto ?? '0'), 0n);
  const dayLeft = DEBATE_DAY_CAP > spent ? DEBATE_DAY_CAP - spent : 0n;
  const budget = [fs.room, fs.capLeft, MAX_THOUGHT_PRICE_YOCTO, dayLeft].reduce((min, x) => x < min ? x : min);
  if (budget < minCallPrice(env, 0)) { await end(env, row, 'unavailable', 'cannot_pay', now); return; }
  if (order === 1) {
    const [left, right] = await Promise.all([
      relation(env.DB, row.first_pet, row.second_pet), relation(env.DB, row.second_pet, row.first_pet),
    ]);
    if ((left?.break_until ?? 0) > now || (right?.break_until ?? 0) > now) {
      await end(env, row, 'unavailable', 'society_refusal', now); return;
    }
  }
  const life = await readLife(env.DB, speakerId);
  const messages = debateMessages(speaker, row.topic,
    lines.filter((line) => line.status === 'settled').map((line) => ({
      speaker: line.speaker_pet === row.first_pet ? pets[0].name : pets[1].name, text: line.text ?? '',
    })),
    { mood: moodOf(fullness(fs.eff).state, life.moodDay, utcDay(now)), energyPercent: energyLeft(life, utcDay(now)) * 10,
      outfit: await wornOf(env.DB, speakerId) }, order >= 3);
  const bound = new TextEncoder().encode(JSON.stringify(messages)).length;
  const maxTokens = ceilingFor(env, bound, budget, FUSE_CHAT);
  if (maxTokens < MIN_LINE) { await end(env, row, 'unavailable', 'cannot_pay', now); return; }
  const inserted = await env.DB.prepare(`INSERT INTO debate_lines (debate_id, line_order, speaker_pet, status, created_at)
    SELECT ?, ?, ?, 'pending', ? WHERE EXISTS (SELECT 1 FROM debates WHERE id = ? AND status IN ('accepted', 'running')
      AND first_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = first_pet), 0)
      AND second_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = second_pet), 0))`)
    .bind(row.id, order, speakerId, now, row.id).run();
  if (inserted.meta.changes !== 1) return;
  if (!await claimDays(env, row, now)) { await end(env, row, 'unavailable', 'daily_slot_used', now); return; }
  if (order === 1) await recordDebateEvent(env, { name: 'debate_started', id: row.id, firstPet: row.first_pet,
    secondPet: row.second_pet, openerPet: row.opener_pet, at: now });
  const answer = await complete(env, { messages, maxTokens, thinking: false, timeoutMs: 60_000 });
  if (answer.kind !== 'answer') {
    track('thought_failed', { for: 'debate', reason: answer.kind === 'paused' ? 'services_paused' : 'model_unavailable' });
    await end(env, row, 'unavailable', answer.kind === 'paused' ? 'services_paused' : 'model_unavailable', Date.now()); return;
  }
  const cost = usd12ToMicros(costUsd12(env, answer.tokensIn, answer.tokensOut));
  const still = await current(env, row);
  if (still === null) {
    await projectPays(env, 'debate_cancelled', cost);
    track('thought_failed', { for: 'debate', reason: 'gift', cost_usd: cost / 1_000_000 });
    await end(env, row, 'gift', 'gift', Date.now());
    return;
  }
  const signed = await signatureOf(env, answer);
  const responseText = replyOf(answer.content).trim();
  const parsed = order >= 3 ? parseReaction(responseText) : null;
  const text = parsed?.reply ?? responseText;
  if (signed === null || text === '') {
    await projectPays(env, 'debate_unavailable', cost);
    track('thought_failed', { for: 'debate', reason: 'model_unavailable', cost_usd: cost / 1_000_000 });
    await end(env, row, 'unavailable', 'model_unavailable', Date.now()); return;
  }
  const price = thoughtPrice(env, [{ tokensIn: answer.tokensIn, tokensOut: answer.tokensOut }]);
  const rate = nearUsdRate(env.NEAR_USD_RATE);
  if (rate === null) throw new Error('rate_missing');
  if (price > budget) {
    await projectPays(env, 'debate_unavailable', cost);
    track('thought_failed', { for: 'debate', reason: 'cannot_pay', cost_usd: cost / 1_000_000 });
    await end(env, row, 'unavailable', 'cannot_pay', Date.now()); return;
  }
  const call = JSON.stringify({ model: env.MODEL_ID, req_sha256: answer.reqSha, res_sha256: answer.resSha,
    signature: signed.signature, sig_kind: signed.sigKind, signer: signed.signer, tokens_in: answer.tokensIn,
    tokens_out: answer.tokensOut, tokens_reasoning: answer.tokensReasoning, cut: false });
  const saved = await env.DB.prepare(`UPDATE debate_lines SET status = 'receipt_pending', text = ?, request_bytes = ?, response_bytes = ?,
    signed_call = ?, price_yocto = ?, near_usd_rate = ?, social_reaction = ? WHERE debate_id = ? AND line_order = ? AND status = 'pending'
    AND EXISTS (SELECT 1 FROM debates WHERE id = ? AND status = 'running'
      AND first_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = first_pet), 0)
      AND second_epoch = COALESCE((SELECT memory_epoch FROM pets WHERE token_id = second_pet), 0))`)
    .bind(text, base64(answer.reqBytes), base64(answer.resBytes), call, price.toString(), String(Math.round(rate * 1_000_000) / 1_000_000),
      parsed?.reaction ?? null, row.id, order, row.id).run();
  if (saved.meta.changes !== 1) {
    await projectPays(env, 'debate_cancelled', cost);
    track('thought_failed', { for: 'debate', reason: 'canceled', cost_usd: cost / 1_000_000 });
    return;
  }
  const fresh = await current(env, row);
  if (fresh === null) {
    await projectPays(env, 'debate_cancelled', cost);
    track('thought_failed', { for: 'debate', reason: 'gift', cost_usd: cost / 1_000_000 });
    await end(env, row, 'gift', 'gift', Date.now()); return;
  }
  const opId = randomId();
  const debitId = speaker.last_debit_id + 1;
  const otherId = speakerId === row.first_pet ? row.second_pet : row.first_pet;
  const args = { token_id: speakerId, debit_id: debitId, thoughts: [{ model: env.MODEL_ID, price: price.toString(),
      calls: [{ req_sha256: answer.reqSha, res_sha256: answer.resSha, signature: signed.signature,
        sig_kind: signed.sigKind, signer: signed.signer, tokens_in: answer.tokensIn, tokens_out: answer.tokensOut,
        tokens_reasoning: answer.tokensReasoning, cut: false }],
      debate: { id: row.id, line_order: order, other_token_id: otherId,
        speaker_transfer_generation: speaker.transfer_generation,
        other_transfer_generation: fresh[speakerId === row.first_pet ? 1 : 0].transfer_generation } }] };
  const prepared = await env.DB.prepare(`INSERT INTO debate_debit_operations
    (debate_id, line_order, operation_id, status, created_at, debit_id, args_json)
    SELECT ?, ?, ?, 'prepared', ?, ?, ? WHERE EXISTS (SELECT 1 FROM debates WHERE id = ? AND status = 'running')`)
    .bind(row.id, order, opId, Date.now(), debitId, JSON.stringify(args), row.id).run();
  if (prepared.meta.changes !== 1) {
    await projectPays(env, 'debate_cancelled', cost);
    track('thought_failed', { for: 'debate', reason: 'canceled', cost_usd: cost / 1_000_000 });
    return;
  }
  const answerTx = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
    methodName: 'debit_session', gas: gasFor(1), args,
    writes: { kind: 'debate_debit', debateId: row.id, lineOrder: order, operationId: opId },
  });
  if (answerTx.status === 'unreachable') {
    const state = await env.DB.prepare('SELECT status FROM debates WHERE id = ?').bind(row.id).first<{ status: string }>();
    const op = await env.DB.prepare('SELECT tx_hash FROM debate_debit_operations WHERE debate_id = ? AND line_order = ?')
      .bind(row.id, order).first<{ tx_hash: string | null }>();
    if ((state === null || state.status === 'gift') && op?.tx_hash == null)
      await projectPays(env, 'debate_cancelled', cost);
    return;
  }
  if (answerTx.status === 'ok' || answerTx.status === 'failed') {
    const line = await env.DB.prepare('SELECT * FROM debate_lines WHERE debate_id = ? AND line_order = ?')
      .bind(row.id, order).first<Line>();
    const op = await env.DB.prepare('SELECT * FROM debate_debit_operations WHERE debate_id = ? AND line_order = ?')
      .bind(row.id, order).first<Operation>();
    if (line !== null && op !== null && answerTx.status === 'ok') await settled(env, row, line, op, Date.now());
    else if (line !== null && op !== null && answerTx.status === 'failed' && answerTx.code === 'gift_version_changed')
      await cancelledAfterGift(env, row, line);
    else if (line !== null && op !== null && answerTx.status === 'failed') await rejected(env, row, line, op, Date.now());
  }
}

/** One durable turn per invocation; the minute cron resumes a lease or an unknown original hash. */
export async function runDebateTurn(env: Env, id: string, now: number = Date.now()): Promise<void> {
  const row = await env.DB.prepare(`UPDATE debates SET lease_until = ? WHERE id = ? AND (status IN ('accepted', 'running')
    OR (status = 'gift' AND EXISTS (SELECT 1 FROM debate_lines WHERE debate_id = ? AND status = 'receipt_pending')))
    AND (lease_until IS NULL OR lease_until < ?) RETURNING *`).bind(now + LEASE_MS, id, id, now).first<Debate>();
  if (row === null) return;
  try {
    const consent = await env.DB.prepare("SELECT COUNT(*) AS n FROM debate_consents WHERE debate_id = ? AND decision = 'accepted'")
      .bind(id).first<{ n: number }>();
    if (consent?.n !== 2) return;
    await oneTurn(env, row, now);
  } catch (error) {
    if (!(error instanceof ChainUnreachable)) throw error;
  } finally {
    await env.DB.prepare('UPDATE debates SET lease_until = NULL WHERE id = ? AND lease_until = ?').bind(id, now + LEASE_MS).run();
  }
}

export async function recoverDueDebates(env: Env, now: number = Date.now()): Promise<void> {
  const due = await env.DB.prepare(`SELECT id FROM debates WHERE (status IN ('accepted', 'running')
    OR (status = 'gift' AND EXISTS (SELECT 1 FROM debate_lines WHERE debate_id = debates.id AND status = 'receipt_pending')))
    AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 8`).bind(now).all<{ id: string }>();
  for (let i = 0; i < due.results.length; i += 4)
    await Promise.all(due.results.slice(i, i + 4).map((row) => runDebateTurn(env, row.id, now)));
  await settlePendingDebateOutcomes(env, now);
}
