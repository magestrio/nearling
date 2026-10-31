// The sheet of one player for one pet, read from the network and D1 now: the GET route answers it,
// and the routes that build a portion or give a snack check it again before they act, so a tap on a
// stale sheet is refused with the sheet as it stands (`409 short`, `409 snack_gone`).
import type { Session } from '../auth';
import { accountBalance, hatchView, type HatchRecord, type PetRecord } from '../chain';
import { utcDay } from '../http';
import { fullnessOf } from '../pet/view';
import { GAS_TOPUP_YOCTO, SNACK_YOCTO } from '../pricing';
import { isPaused } from '../servicePause';
import { feedSheet, needsGasAccount, snackLine, type Sheet } from './sheet';
import { readWallet, type PlayerWallet } from './wallet';

export interface SheetRead {
  sheet: Sheet;
  wallet: PlayerWallet;
  hatch: HatchRecord;
  viewer: 'owner' | 'guest';
  /** Whether the gas account can give the top-up; `null` when the answer did not depend on it. */
  gasAccountHolds: boolean | null;
}

/** Throws `ChainUnreachable` when the pet, the wallet or the pool cannot be read. */
export async function readSheet(env: Env, session: Pick<Session, 'sub' | 'accountId'>, tokenId: string, pet: PetRecord, rate: number): Promise<SheetRead> {
  const wallet = await readWallet(env, session);
  const hatch = await hatchView(env, session.accountId);
  const viewer = pet.owner_id === session.accountId ? 'owner' : 'guest';
  const nowMs = Date.now();

  const fullness = await fullnessOf(env.DB, tokenId, pet);
  // The friend's own snacks of today (§8 › Перекусы друзей): this pet, and how many different pets.
  let friendToday = { thisPet: false, pets: 0 };
  if (viewer === 'guest') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS pets, COALESCE(SUM(token_id = ?1), 0) AS here FROM friend_snacks WHERE account = ?2 AND day = ?3')
      .bind(tokenId, session.accountId, utcDay(nowMs))
      .first<{ pets: number; here: number }>();
    friendToday = { thisPet: (row?.here ?? 0) > 0, pets: row?.pets ?? 0 };
  }

  const pre = { viewer, fullness, pet, friendToday, nowMs } as const;
  // The pause and the pool only matter where the snack would be given.
  const snackPaused = snackLine(pre).state === 'ready' && ((await isPaused(env.DB, 'snack')) || BigInt(hatch.pool) < SNACK_YOCTO);
  // The gas account is read only when the portions' answer depends on it.
  const gasAccountHolds = needsGasAccount(wallet) ? BigInt(await accountBalance(env, env.GAS_ACCOUNT_ID)) >= GAS_TOPUP_YOCTO : null;

  const sheet = feedSheet({
    ...pre,
    name: pet.name,
    rate,
    wallet,
    gasAccountHolds,
    snackPaused,
    hatched: hatch.token_id !== null,
    firstName: wallet.firstName,
  });
  return { sheet, wallet, hatch, viewer, gasAccountHolds };
}
