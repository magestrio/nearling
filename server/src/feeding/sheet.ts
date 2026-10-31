// What Feed sheet shows, whole, from the server (`Feed sheet screen`, `Snack rule`, `Player wallet
// data`, `Feeding gas data`): the portions with what each is short of, the wallet's state and the one
// line that stands in the snack's place. The client draws it and holds no logic about gas, the
// project's top-up or the snack's limits. `feedSheet` is pure: the route reads the network and D1 and
// hands the numbers in.
import type { PetRecord } from '../chain';
import { utcDay } from '../http';
import {
  FEED_GAS_YOCTO,
  FEED_PORTIONS,
  FRIEND_SNACK_PETS_PER_DAY,
  OWNER_SNACK_EVERY_MS,
  PET_FRIEND_SNACKS_PER_DAY,
  portionCents,
  type Fullness,
  type PortionNear,
} from '../pricing';

/** The line that stands in the snack's place (`Snack rule` › «several lines at once»). */
export type SnackLine =
  /** The snack can be given. */
  | { state: 'ready' }
  /** No snack and no line: the owner's pet is awake. */
  | { state: 'none' }
  /** The owner's next snack is ready at `at` (ISO). */
  | { state: 'not_ready'; at: string }
  /** This friend gave this pet a snack today. */
  | { state: 'given' }
  /** The pet has had its three snacks from friends today; more at `until` (ISO, 00:00 UTC). */
  | { state: 'pet_full'; until: string }
  /** This friend has shared snacks with the most pets for today; more at `until`. */
  | { state: 'shared_all'; until: string }
  /** The project has nothing to give a snack with (`Feeding connection rule` › «перекусы на паузе»). */
  | { state: 'paused' };

export interface SheetPortion {
  near: PortionNear;
  yocto: string;
  /** Whole US cents at the rate of NEAR. */
  cents: number;
  /** What the player must add to give this portion, NEAR rounded up to two decimals ("0.13"); null when it fits. */
  missing: string | null;
}

export interface Sheet {
  viewer: 'owner' | 'guest';
  name: string;
  fullness: Fullness;
  portions: SheetPortion[];
  /** `none`: nothing in the wallet but the project's gas; the balance is not shown. */
  wallet: { state: 'some'; balance: string } | { state: 'none' };
  snack: SnackLine;
  /** The player has a pet of their own (the thanks says «Get your own pet» when not). */
  hatched: boolean;
  /** The feeder's own first name for the thanks, when it passed `Feeder identity data`. */
  friend: string | null;
}

export interface SheetInput {
  viewer: 'owner' | 'guest';
  name: string;
  fullness: Fullness;
  /** USD per NEAR. */
  rate: number;
  wallet: { balance: bigint; gasAdded: bigint; topUpGiven: boolean };
  /** Whether the gas account holds the top-up; `null` when `needsGasAccount` said the answer does not depend on it. */
  gasAccountHolds: boolean | null;
  pet: Pick<PetRecord, 'friend_snack_day' | 'friend_snacks' | 'owner_snack_at'>;
  /** The viewer's `friend_snacks` rows of today (D1): for this pet, and how many different pets. */
  friendToday: { thisPet: boolean; pets: number };
  /** Free snacks are paused on our side: the services are paused or the pool is under the snack. */
  snackPaused: boolean;
  hatched: boolean;
  firstName: string | null;
  nowMs: number;
}

const HUNDREDTH_NEAR = 10n ** 22n;

/** `ceil2`: the shortfall in NEAR rounded up to two decimals, as text ("0.13"). */
export function ceil2(yocto: bigint): string {
  const hundredths = (yocto + HUNDREDTH_NEAR - 1n) / HUNDREDTH_NEAR;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/** The wallet holds nothing but the project's gas. */
function holdsOnlyProjectGas(wallet: SheetInput['wallet']): boolean {
  return wallet.balance <= wallet.gasAdded;
}

/** True when the portions' answer depends on whether the gas account can give the top-up, so the
 * route reads that balance: only for a wallet with NEAR whose top-up is still due, and only when some
 * portion does not fit with its gas anyway. "Nothing in the wallet" never reads it (the whole 0.01,
 * `Player wallet data`). */
export function needsGasAccount(wallet: SheetInput['wallet']): boolean {
  if (wallet.topUpGiven || holdsOnlyProjectGas(wallet)) return false;
  return FEED_PORTIONS.some((p) => wallet.balance < p.yocto + FEED_GAS_YOCTO);
}

function portionsOf(input: SheetInput): SheetPortion[] {
  const { wallet } = input;
  const none = holdsOnlyProjectGas(wallet);
  // A top-up is still due when it was not given and the gas account can give it; then the portion
  // alone is the need. Otherwise its gas is the wallet's own to pay.
  let topUpDue = false;
  if (!none && !wallet.topUpGiven) {
    if (input.gasAccountHolds === null && needsGasAccount(wallet)) throw new Error('gas_account_unread');
    topUpDue = input.gasAccountHolds === true;
  }
  return FEED_PORTIONS.map((p) => {
    let need: bigint;
    let have: bigint;
    if (none) {
      // The project's gas is not the player's NEAR: with no top-up given the whole portion is missing.
      have = wallet.topUpGiven ? wallet.balance : 0n;
      need = p.yocto + (wallet.topUpGiven ? FEED_GAS_YOCTO : 0n);
    } else {
      have = wallet.balance;
      need = p.yocto + (topUpDue ? 0n : FEED_GAS_YOCTO);
    }
    return {
      near: p.near,
      yocto: p.yocto.toString(),
      cents: portionCents(p.yocto, input.rate),
      missing: have >= need ? null : ceil2(need - have),
    };
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The snack's line by `Snack rule`, without the pause: the first that holds. */
export function snackLine(input: Pick<SheetInput, 'viewer' | 'fullness' | 'pet' | 'friendToday' | 'nowMs'>): SnackLine {
  const { viewer, pet, nowMs } = input;
  if (viewer === 'owner') {
    if (input.fullness.state !== 'asleep') return { state: 'none' };
    const last = BigInt(pet.owner_snack_at);
    const nowNs = BigInt(nowMs) * 1_000_000n;
    const every = OWNER_SNACK_EVERY_MS * 1_000_000n;
    if (last === 0n || nowNs - last >= every) return { state: 'ready' };
    return { state: 'not_ready', at: iso(Number((last + every + 999_999n) / 1_000_000n)) };
  }
  const today = utcDay(nowMs);
  const until = iso((today + 1) * 86_400_000);
  if (input.friendToday.thisPet) return { state: 'given' };
  if (pet.friend_snack_day === today && pet.friend_snacks >= PET_FRIEND_SNACKS_PER_DAY) return { state: 'pet_full', until };
  if (input.friendToday.pets >= FRIEND_SNACK_PETS_PER_DAY) return { state: 'shared_all', until };
  return { state: 'ready' };
}

export function feedSheet(input: SheetInput): Sheet {
  const none = holdsOnlyProjectGas(input.wallet);
  const base = snackLine(input);
  // The pause stands only where the snack would be allowed (`Feeding connection rule`).
  const snack: SnackLine = base.state === 'ready' && input.snackPaused ? { state: 'paused' } : base;
  return {
    viewer: input.viewer,
    name: input.name,
    fullness: input.fullness,
    portions: portionsOf(input),
    wallet: none ? { state: 'none' } : { state: 'some', balance: input.wallet.balance.toString() },
    snack,
    hatched: input.hatched,
    friend: input.viewer === 'guest' ? input.firstName : null,
  };
}
