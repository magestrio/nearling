// The free snack (`Snack rule`, `Pet snack contract`): the server sends `pet_snack` with its own key;
// the player signs nothing. The kind comes from the network (the owner or anyone else), the account
// from the session - never from the request.
import type { Session } from '../auth';
import { ChainUnreachable, hatchView, PET_SNACK_TGAS, petView, txStatus } from '../chain';
import { utcDay } from '../http';
import { FRIEND_SNACK_PETS_PER_DAY } from '../pricing';
import { settleFeeding } from '../pet/settle';
import { gasIsLow } from '../servicePause';
import { askNetwork, outcomeAnswer, rowOfPlayer } from './inflight';
import type { Reply } from './portion';
import { readSheet } from './read';
import { fundingTag } from '../errands/funding';

/** The contract's refusals that the sheet already has a line for: the snack is gone, the sheet redraws. */
const SHEET_CODES = new Set(['snacks_today', 'snack_too_soon', 'pool_empty', 'feeder_not_owner']);

const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function giveSnack(env: Env, session: Session, tokenId: string, rate: number, code?: unknown): Promise<Reply> {
  try {
    const pet = await petView(env, tokenId);
    if (pet === null) return { status: 404, body: { code: 'no_pet' } };
    const tag = await fundingTag(env, tokenId, session, code, pet);
    if (tag.error !== undefined) return { status: 409, body: { code: tag.error } };
    if ((await rowOfPlayer(env.DB, session.accountId)) !== null) return { status: 409, body: { code: 'pending' } };

    // The balance of the server's gas is read before a snack: a low one pauses the services now.
    const now = Date.now();
    await gasIsLow(env, now);
    // The sheet as it stands now: the pet is read again, the network has moved since the first read.
    const gone = async (): Promise<Reply> => {
      const now = (await petView(env, tokenId)) ?? pet;
      return { status: 409, body: { code: 'snack_gone', sheet: { chain: true, ...(await readSheet(env, session, tokenId, now, rate)).sheet } } };
    };
    const read = await readSheet(env, session, tokenId, pet, rate);
    if (read.sheet.snack.state !== 'ready') return { status: 409, body: { code: 'snack_gone', sheet: { chain: true, ...read.sheet } } };

    const kind = read.viewer === 'owner' ? 'owner' : 'friend';
    const via = kind === 'owner' ? 'owner' : 'link';
    const id = randomId();
    const placed = await env.DB.prepare(
      "INSERT INTO feedings (id, sub, account, token_id, source, via, deposit_yocto, tx_hash, created_at, job_hash) VALUES (?1, ?2, ?3, ?4, 'snack', ?5, NULL, NULL, ?6, ?7) ON CONFLICT (account) DO NOTHING",
    )
      .bind(id, session.sub, session.accountId, tokenId, via, now, tag.hash)
      .run();
    if (placed.meta.changes === 0) return { status: 409, body: { code: 'pending' } };
    const row = (await rowOfPlayer(env.DB, session.accountId))!;

    if (kind === 'friend') {
      // One statement: this pet once a day and three pets a day, however many taps and tabs.
      const reserved = await env.DB.prepare(
        'INSERT INTO friend_snacks (account, token_id, day) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM friend_snacks WHERE account = ?1 AND day = ?3) < ?4 ON CONFLICT DO NOTHING',
      )
        .bind(session.accountId, tokenId, utcDay(now), FRIEND_SNACK_PETS_PER_DAY)
        .run();
      if (reserved.meta.changes === 0) {
        await env.DB.prepare('DELETE FROM feedings WHERE id = ?').bind(id).run();
        return gone();
      }
    }

    const answer = await env.SERVER_KEY.get(env.SERVER_KEY.idFromName('server')).send({
      methodName: 'pet_snack',
      args: { token_id: tokenId, feeder: session.accountId, kind, ...(tag.hash === null ? {} : { job_hash: tag.hash }) },
      gas: (PET_SNACK_TGAS * 1_000_000_000_000n).toString(),
    });
    const hatched = read.hatch.token_id !== null;
    if (answer.status === 'unreachable') {
      await settleFeeding(env, row, { status: 'failed', code: 'unreachable' });
      return { status: 503, body: { code: 'chain_unreachable' } };
    }
    if (answer.status === 'unknown') {
      // Not known to have failed: the row and the reservation stay until the network answers.
      console.log('snack_unknown');
      await env.DB.prepare('UPDATE feedings SET tx_hash = ? WHERE id = ?').bind(answer.txHash, id).run();
      return { status: 200, body: await outcomeAnswer(env.DB, session.sub, 'unknown', null, hatched, false) };
    }
    if (answer.status === 'failed') {
      await settleFeeding(env, row, { status: 'failed', code: answer.code });
      if (tag.hash !== null && answer.code === 'job_funded') return { status: 409, body: { code: 'shared_funding_closed' } };
      if (SHEET_CODES.has(answer.code)) return gone();
      return { status: 200, body: await outcomeAnswer(env.DB, session.sub, 'failed', null, hatched, false) };
    }
    // A confirmed send can still leave its feed row pending if the pet view needed for
    // a named wake is unavailable. The cron needs this hash to finish that settlement.
    await env.DB.prepare('UPDATE feedings SET tx_hash = ? WHERE id = ?').bind(answer.txHash, id).run();
    await settleFeeding(env, { ...row, tx_hash: answer.txHash }, { status: 'ok', value: answer.value, ...(answer.burnt !== undefined ? { burnt: answer.burnt } : {}) });
    return { status: 200, body: await outcomeAnswer(env.DB, session.sub, 'ok', null, hatched, via === 'link') };
  } catch (e) {
    if (e instanceof ChainUnreachable) return { status: 503, body: { code: 'chain_unreachable' } };
    throw e;
  }
}

/** The outcome of a meal or a snack for a tab that has no signed bytes - after a reload, on a reopened
 * sheet, for a snack (`POST …/feed/outcome`). A row stands: ask the network by its hash. No row: the
 * flow was settled; a portion is looked up by its id (its hash); a snack has no hash in the client, so
 * the friend's answer is whether the reservation stands (a failure removed it), the owner's whether
 * `owner_snack_at` is within the last day (only this snack can be under the 72 hours). */
export async function feedOutcome(env: Env, session: Session, tokenId: string, input: { id?: unknown; source?: unknown }): Promise<Reply> {
  if (typeof input.id !== 'string' || (input.source !== 'near' && input.source !== 'snack')) return { status: 400, body: { code: 'bad_request' } };
  const source = input.source;
  if (source === 'near' && !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(input.id)) return { status: 400, body: { code: 'bad_request' } };
  if (source === 'snack' && !/^[0-9a-f]{24}$/.test(input.id)) return { status: 400, body: { code: 'bad_request' } };
  try {
    const pet = await petView(env, tokenId);
    if (pet === null) return { status: 404, body: { code: 'no_pet' } };
    const hatched = (await hatchView(env, session.accountId)).token_id !== null;
    const friendly = pet.owner_id !== session.accountId;
    const answer = async (status: 'ok' | 'failed' | 'unknown', settled = false) => {
      const body = await outcomeAnswer(env.DB, session.sub, status, source === 'near' ? input.id as string : null, hatched, friendly);
      // `settled`: no row of the player stands for this id, so no flow is left that could end the tab's watch.
      return { status: 200 as const, body: settled ? { ...body, settled: true } : body };
    };

    const row = await rowOfPlayer(env.DB, session.accountId);
    if (row !== null && row.id === input.id && row.source === source) {
      const known = await askNetwork(env, row);
      return answer(known?.status ?? 'unknown');
    }
    if (source === 'near') {
      // No answer is no outcome: `txStatus` says the same for a hash it never saw and for its own timeout.
      const seen = await txStatus(env, input.id, session.accountId);
      if (seen?.status === 'ok' || seen?.status === 'failed') return answer(seen.status);
      // Still never `failed` on silence, but the watcher gets its exit: no row, so nothing will settle this id.
      return answer('unknown', true);
    }
    if (friendly) {
      // Yesterday's too: a snack of the last seconds of a UTC day is asked after in the next, and its
      // reservation stands until `clean` takes it.
      const day = utcDay(Date.now());
      const reserved = await env.DB.prepare('SELECT 1 AS found FROM friend_snacks WHERE account = ? AND token_id = ? AND day IN (?, ?)').bind(session.accountId, tokenId, day, day - 1).first();
      return answer(reserved === null ? 'failed' : 'ok');
    }
    const last = BigInt(pet.owner_snack_at);
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    return answer(last !== 0n && nowNs - last < 86_400_000_000_000n ? 'ok' : 'failed');
  } catch (e) {
    if (e instanceof ChainUnreachable) return { status: 503, body: { code: 'chain_unreachable' } };
    throw e;
  }
}
