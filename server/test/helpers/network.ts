// The network of a Worker test: every outbound `fetch` of the Worker lands here and nothing reaches
// the internet. Two services are played:
//
//  - Privy's JWKS (`PRIVY_JWKS_URL`): the public key of a key pair made for the test, so the test
//    signs identity tokens the Worker verifies (`token()`).
//  - The NEAR JSON-RPC (`NEAR_RPC_URL`): a small model of the Nearling contract answering
//    `pet_view`, `hatch_view`, `nft_supply_for_owner`, `view_account`, and executing `pet_mint`
//    from a transaction the Worker really signed and sent (`query`, `block`, `send_tx`, `tx` in the
//    shapes of nearcore's JSON-RPC). The model keeps the contract's rules that a Scenario relies on
//    (one pet per account, 50 a day, the pool, the name and character limits); the contract itself
//    is proved by `contract/tests/`.
//
// A fake answers what the real service answers; its shapes are nearcore's, read from near-api-js.
import { env } from 'cloudflare:workers';
import { baseDecode, baseEncode, decodeSignedTransaction, encodeTransaction, KeyPairEd25519 } from 'near-api-js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';
import { riddleHash } from '../../src/riddle/hash';
import { isPrivateAddress } from '../../src/errands/reader';

export const NEAR_ACCOUNT = (n: number) => n.toString(16).padStart(64, '0');

export interface FakePet {
  owner_id: string;
  name: string;
  character: string;
  born_at: number;
  project_food: string;
  given_food: string;
  debit_day: number;
  debited_today: string;
  last_debit_id: number;
  stage: string;
  stage_day: number;
  streak: number;
  freezes: number;
  friend_snack_day: number;
  friend_snacks: number;
  owner_snack_at: string;
  /** In the order gained, a repeat twice (`pet_view` of the contract). */
  traits: string[];
  /** The UTC day of the last streak mark; `null` before the first (`Option<u64>` of `PetView`). */
  last_streak_day: number | null;
  /** The item ids the pet has, ascending (`Vec<u8>` of `PetView`). */
  outfits: number[];
  /** The pets met through work, ascending (`pet_view.work_known`); absent reads as none. */
  work_known?: string[];
  jobs_today?: number;
}

/** One thought of a `debit_session` batch as the Worker sends it (`ThoughtReceipt`). */
export interface FakeThought {
  price: string;
  calls: unknown[];
  worker?: string;
  hire?: { kind: 'player' | 'pet'; skill: boolean; fee: string };
}

/** The traits a `pet_grow` takes (`Trait` of the contract, JSON). */
const FAKE_TRAITS = ['clever', 'sociable', 'hard_working', 'thoughtful', 'cozy'];
const NEXT_STAGE: Record<string, string> = { Baby: 'Teen', Teen: 'Adult' };

export type SendMode =
  | 'normal'
  // The transaction is executed but the answer never arrives: the outcome is unknown to the Worker.
  | 'executed-but-silent'
  // The transaction never reaches the chain and the answer never arrives.
  | 'lost'
  // The first delivery is rejected with an invalid nonce (nothing is executed), the next is fine.
  | 'nonce-once'
  // Every delivery is refused: the nonce is stale (nothing is executed), or the signer cannot pay.
  | 'invalid-nonce'
  | 'not-enough-balance';

/** nearcore's answer to a transaction it refuses (JSON-RPC `send_tx`), `InvalidTxError` in `data`. */
function invalidTx(invalid: unknown): unknown {
  return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: invalid } } } };
}

/** nearcore's answer to a view of an account it has no record of. */
const unknownAccount = (account: string) => ({
  error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: account, block_hash: 'x', block_height: 1000 } }, code: -32000, message: 'Server error', data: `account ${account} does not exist while viewing` },
});

/** A storage record of an acquaintance, 72 bytes (`KNOWN_RECORD_BYTES`), in yoctoNEAR. */
const KNOWN_COST = 720_000_000_000_000_000_000n;

/** The storage of one riddle commit, 81 bytes (`RIDDLE_COMMIT_BYTES`), in yoctoNEAR. */
const RIDDLE_COMMIT_COST = 810_000_000_000_000_000_000n;

export class FakeContract {
  /** The balances of every account but the server's: the gas account, the players' wallets. An
   * account that is not here does not exist (its `view_account` is `UNKNOWN_ACCOUNT`). */
  balances = new Map<string, bigint>([[env.GAS_ACCOUNT_ID, 1_500_000_000_000_000_000_000_000n]]);
  /** `(token_id, account)` of the acquaintances the contract recorded (`pet_knows`). */
  known = new Set<string>();
  /** Every `feed` event: the meals the contract took. */
  feeds: { token_id: string; feeder: string; amount: string }[] = [];
  /** Every account whose `view_account` the Worker asked for. */
  viewed: string[] = [];
  /** Every `snack` event. */
  snacks: { token_id: string; kind: string; friend?: string }[] = [];
  pets = new Map<string, FakePet>();
  hatchedBy = new Map<string, string>();
  /** The UTC day of the (faked) clock, as the contract's `block_timestamp` would say. */
  get day(): number {
    return this.dayOverride ?? Math.floor(Date.now() / 86_400_000);
  }
  /** When set, the chain's day is this number whatever the clock says (a node a moment behind). */
  dayOverride: number | null = null;
  /** Every `grow` event: the transitions the contract took. */
  grows: { token_id: string; stage: string; trait: string }[] = [];
  /** When set, `pet_grow` fails with this contract code even if its rules would pass. */
  growFails: string | null = null;
  /** The riddle commits on chain by UTC day (64 hex characters), and the reserve that pays for them. */
  riddleCommits = new Map<number, string>();
  /** Empty, as on a contract nobody has funded (`riddle_storage_fund`): the cron's commit waits, sends
   * nothing, and the tests of other flows count only their own transactions. `fundRiddles()` fills it. */
  riddleReserve = 0n;
  fundRiddles(): void {
    this.riddleReserve = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
  }
  /** Every accepted `riddle_commit` and `riddle_reveal` / `streak_mark`. */
  commits: { day: number; hash: string }[] = [];
  reveals: { day: number; riddle: string; answers: string[]; salt: string }[] = [];
  marks: { token_id: string; day: number; skipped: number; streak: number; freezes: number; spent: number }[] = [];
  /** When set, the method fails with this contract code even if its rules would pass. */
  commitFails: string | null = null;
  revealFails: string | null = null;
  markFails: string | null = null;
  /** When set, `outfit_grant` / `outfit_buy` fail with this contract code even if their rules would pass. */
  grantFails: string | null = null;
  buyFails: string | null = null;
  /** Every accepted `outfit_grant` and `outfit_buy` (`outfit` events), and what the treasury got. */
  grants: { token_id: string }[] = [];
  buys: { token_id: string; item: number; price: string }[] = [];
  treasury = 0n;
  /** What the next successful transaction burns, yoctoNEAR (`tokens_burnt` of its outcome). */
  burnt = '0';
  /** When set, `debit_session` fails with this contract code even if its rules would pass. */
  debitFails: string | null = null;
  bornToday = 0;
  pool = 1_000_000_000_000_000_000_000_000n; // 1 NEAR
  nextId = 0;
  serverBalance = 10_000_000_000_000_000_000_000_000n;
  /** Every contract view call the Worker made, as `method:args`. */
  reads: { method: string; args: Record<string, unknown> }[] = [];
  /** Every transaction the Worker sent to the contract. */
  sends: { method: string; args: Record<string, unknown>; gas: string; deposit: string; signer: string; nonce: number }[] = [];
  mode: SendMode = 'normal';
  /** Final chain height; the signed transaction's reference block is height 1000. */
  blockHeight = 1000;
  /** Execution block time for a gift test whose status node lags the owner view. */
  blockTimestampMs: number | null = null;
  /** The execution block is temporarily unavailable from this RPC node. */
  blockBlind = false;
  /** When set, a transaction waits for it before the RPC answers (a slow chain). */
  sendGate: Promise<void> | null = null;
  /** Every transaction that reached the RPC (also the ones whose answer was lost). */
  attempts = 0;
  private signedHashes = new Set<string>();
  /** When set, the whole RPC answers 503. */
  down = false;
  /** When set, a plain transfer is executed and fails (the receipt fails), moving nothing. */
  transferFails: string | null = null;
  /** When set, `pet_mint` fails with this contract code (a panic). */
  mintFails: string | null = null;
  /** How `tx` answers a hash it has never seen. nearcore polls until its own timeout (`TIMEOUT_ERROR`);
   * `UNKNOWN_TRANSACTION` comes only from a non-waiting status. */
  unseenTx: 'unknown' | 'timeout' = 'unknown';
  /** A node that has not reached the block yet: `tx` answers every hash as unseen. */
  txBlind = false;
  /** How far behind the next `pet_view`s answer, in accepted debits, one number per read: the reads
   * of a debit may hit RPC nodes at different heights. */
  lag: number[] = [];
  /** Each runs once, inside the next RPC call of that name and before it answers: what the rest of
   * the world does while the Worker waits on that call. */
  meanwhile: { view_account?: () => Promise<void>; pet_view?: () => Promise<void>; send_tx?: () => Promise<void> } = {};
  outcomes = new Map<string, unknown>();
  /** A pet as it stood before each of its accepted debits, the oldest first. */
  private past = new Map<string, FakePet[]>();
  private applied = new Set<string>();
  private nonce = 100;
  /** The nonce of a player's key after the transactions of it that executed (a project key's stays
   * at `nonce`: the Worker's own accounts keep their cache). */
  private playerNonces = new Map<string, number>();
  private nonceRejected = false;

  addPet(id: string, owner: string, patch: Partial<FakePet> = {}): FakePet {
    const pet: FakePet = {
      owner_id: owner,
      name: 'Pixel',
      character: 'I am a test character.',
      born_at: 1,
      project_food: env.STARTER_FOOD,
      given_food: '0',
      debit_day: this.day,
      debited_today: '0',
      last_debit_id: 0,
      stage: 'Baby',
      stage_day: this.day,
      streak: 0,
      freezes: 1,
      friend_snack_day: 0,
      friend_snacks: 0,
      owner_snack_at: '0',
      traits: [],
      last_streak_day: null,
      outfits: [],
      ...patch,
    };
    this.pets.set(id, pet);
    return pet;
  }

  ownedBy(account: string): number {
    return [...this.pets.values()].filter((p) => p.owner_id === account).length;
  }

  /** Views that fail (the node errors) while the rest of the contract answers. */
  failingViews = new Set<string>();

  view(method: string, args: Record<string, unknown>): unknown {
    this.reads.push({ method, args });
    if (this.failingViews.has(method)) throw new Error(`the fake node fails ${method}`);
    switch (method) {
      case 'pet_view': {
        const before = this.past.get(String(args.token_id)) ?? [];
        return before[before.length - (this.lag.shift() ?? 0)] ?? this.pets.get(String(args.token_id)) ?? null;
      }
      case 'hatch_view':
        return {
          token_id: this.hatchedBy.get(String(args.account_id)) ?? null,
          day: this.day,
          born_today: this.bornToday,
          pool: this.pool.toString(),
        };
      case 'riddle_view':
        return { hash: this.riddleCommits.get(Number(args.day)) ?? null, reserve: this.riddleReserve.toString(), commit_cost: RIDDLE_COMMIT_COST.toString() };
      case 'nft_supply_for_owner':
        return String(this.ownedBy(String(args.account_id)));
      case 'nft_tokens_for_owner':
        return [...this.pets].filter(([, p]) => p.owner_id === String(args.account_id)).map(([token_id]) => ({ token_id, owner_id: String(args.account_id) })).slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 50));
      case 'pet_knows':
        return this.known.has(`${String(args.token_id)}:${String(args.account_id)}`);
      default:
        throw new Error(`the fake contract has no view ${method}`);
    }
  }

  /** The contract's `pet_mint`: a panic code, or the new token id. */
  mint(receiver: string, name: string, character: string): { code: string } | { tokenId: string } {
    const enc = new TextEncoder();
    if (this.mintFails !== null) return { code: this.mintFails };
    if (this.hatchedBy.has(receiver)) return { code: 'already_hatched' };
    if (this.bornToday >= 50) return { code: 'daily_births' };
    if (enc.encode(name).length > 32) return { code: 'name_too_long' };
    if (enc.encode(character).length > Number(env.MAX_CHARACTER_BYTES)) return { code: 'character_too_long' };
    const cost = BigInt(env.MAX_BIRTH_COST);
    if (this.pool < cost) return { code: 'pool_empty' };
    const id = String(this.nextId++);
    this.addPet(id, receiver, { name, character });
    this.hatchedBy.set(receiver, id);
    this.bornToday += 1;
    this.pool -= cost;
    return { tokenId: id };
  }

  /** The contract's `debit_session`: a panic code, or nothing. Its rules are the ones the Scenarios of
   * `Session debit contract` name; the contract itself is proved by `contract/tests/`. */
  debit(tokenId: string, debitId: number, thoughts: FakeThought[]): { code: string } | null {
    const pet = this.pets.get(tokenId);
    if (this.debitFails !== null) return { code: this.debitFails };
    if (!pet) return { code: 'no_pet' };
    if (thoughts.length === 0) return { code: 'empty_batch' };
    if (thoughts.length > 12) return { code: 'too_many_thoughts' };
    if (debitId !== pet.last_debit_id + 1) return { code: 'bad_debit_id' };
    // The thoughts without a hire cost their price; a hire its fee, which holds the worker's answer. A refused hire
    // is `hire:<index>:<code>`, as the contract panics (`Hire debit contract`).
    let rest = 0n;
    let fromGivenOnly = 0n;
    const hires: { worker: FakePet; workerId: string; fee: bigint; price: bigint }[] = [];
    const jobsGiven = new Map<string, number>();
    for (const [i, t] of thoughts.entries()) {
      const price = BigInt(t.price);
      if (price > 5_000_000_000_000_000_000_000n) return { code: 'price_over_cap' };
      if (t.hire === undefined) {
        rest += price;
        continue;
      }
      const fee = BigInt(t.hire.fee);
      const worker = t.worker === undefined ? undefined : this.pets.get(t.worker);
      if (worker === undefined || t.worker === undefined) return { code: `hire:${i}:no_worker` };
      if (fee < 830_000_000_000_000_000_000n || fee > 4_430_000_000_000_000_000_000n) return { code: `hire:${i}:fee_band` };
      if (price >= fee) return { code: `hire:${i}:answer_over_fee` };
      if (worker.owner_id === pet.owner_id) return { code: `hire:${i}:same_owner` };
      const jobs = (worker.jobs_today ?? 0) + (jobsGiven.get(t.worker) ?? 0);
      if (jobs >= 10) return { code: `hire:${i}:jobs` };
      jobsGiven.set(t.worker, (jobsGiven.get(t.worker) ?? 0) + 1);
      if (t.hire.kind === 'pet' && !(pet.work_known ?? []).includes(t.worker) && !this.known.has(`${tokenId}:${worker.owner_id}`)) return { code: `hire:${i}:not_known` };
      if (t.hire.kind === 'pet') {
        fromGivenOnly += fee;
        if (fromGivenOnly > BigInt(pet.given_food)) return { code: `hire:${i}:given_short` };
      } else {
        rest += fee;
      }
      hires.push({ worker, workerId: t.worker, fee, price });
    }
    const sum = rest + fromGivenOnly;
    const already = pet.debit_day === this.day ? BigInt(pet.debited_today) : 0n;
    if (already + sum > 50_000_000_000_000_000_000_000n) return { code: 'daily_cap' };
    const project = BigInt(pet.project_food);
    const given = BigInt(pet.given_food) - fromGivenOnly;
    if (rest > project + given) return { code: 'over_food' };
    const fromProject = rest < project ? rest : project;
    this.past.set(tokenId, [...(this.past.get(tokenId) ?? []), { ...pet }]);
    pet.project_food = (project - fromProject).toString();
    pet.given_food = (given - (rest - fromProject)).toString();
    pet.debit_day = this.day;
    pet.debited_today = (already + sum).toString();
    pet.last_debit_id = debitId;
    for (const { worker, workerId, fee, price } of hires) {
      worker.given_food = (BigInt(worker.given_food) + fee - price).toString();
      worker.jobs_today = (worker.jobs_today ?? 0) + 1;
      const pair = (list: string[] | undefined, other: string) => [...new Set([...(list ?? []), other])].sort((a, b) => Number(a) - Number(b));
      pet.work_known = pair(pet.work_known, workerId);
      worker.work_known = pair(worker.work_known, tokenId);
    }
    this.debits.push({ tokenId, debitId, thoughts });
    return null;
  }
  /** The contract's `introduce`: the pool pays the record of a new acquaintance before it is written. */
  private introduce(tokenId: string, feeder: string, reserve: bigint): boolean {
    const key = `${tokenId}:${feeder}`;
    if (this.known.has(key) || this.pool < KNOWN_COST + reserve) return false;
    this.known.add(key);
    this.pool -= KNOWN_COST;
    return true;
  }

  /** The contract's `pet_feed`: a panic code, or whether an acquaintance was recorded. */
  feed(feeder: string, tokenId: string, deposit: bigint): { code: string } | { wrote: boolean } {
    if (deposit < BigInt(env.MIN_FEED)) return { code: 'feed_too_small' };
    const pet = this.pets.get(tokenId);
    if (!pet) return { code: 'no_pet' };
    pet.given_food = (BigInt(pet.given_food) + deposit).toString();
    this.feeds.push({ token_id: tokenId, feeder, amount: deposit.toString() });
    return { wrote: feeder !== pet.owner_id && this.introduce(tokenId, feeder, 0n) };
  }

  /** The contract's `pet_snack`, in its order of checks: caller, pet, the kind's cap, the pool. */
  snack(caller: string, tokenId: string, feeder: string, kind: string): { code: string } | { wrote: boolean } {
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    const pet = this.pets.get(tokenId);
    if (!pet) return { code: 'no_pet' };
    const amount = BigInt(env.SNACK_AMOUNT);
    if (kind === 'friend') {
      if (pet.friend_snack_day === this.day && pet.friend_snacks >= Number(env.FRIEND_SNACKS_PER_DAY)) return { code: 'snacks_today' };
    } else {
      if (feeder !== pet.owner_id) return { code: 'feeder_not_owner' };
      const last = BigInt(pet.owner_snack_at);
      if (last !== 0n && BigInt(Date.now()) * 1_000_000n - last < BigInt(env.OWNER_SNACK_EVERY_NS)) return { code: 'snack_too_soon' };
    }
    if (this.pool < amount) return { code: 'pool_empty' };
    this.pool -= amount;
    pet.project_food = (BigInt(pet.project_food) + amount).toString();
    if (kind === 'friend') {
      pet.friend_snacks = pet.friend_snack_day === this.day ? pet.friend_snacks + 1 : 1;
      pet.friend_snack_day = this.day;
    } else {
      pet.owner_snack_at = (BigInt(Date.now()) * 1_000_000n).toString();
    }
    this.snacks.push({ token_id: tokenId, kind, ...(kind === 'friend' ? { friend: feeder } : {}) });
    return { wrote: kind === 'friend' && this.introduce(tokenId, feeder, 0n) };
  }

  /** The contract's `pet_grow`, in its order of checks: the caller, the pet, the next stage, the day.
   * A trait outside the list fails at parsing, before the first check. */
  grow(caller: string, tokenId: string, stage: string, trait: string): { code: string } | null {
    if (!FAKE_TRAITS.includes(trait)) return { code: 'Failed to deserialize input from JSON' };
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    const pet = this.pets.get(tokenId);
    if (!pet) return { code: 'no_pet' };
    if (this.growFails !== null) return { code: this.growFails };
    if (NEXT_STAGE[pet.stage] !== stage) return { code: 'bad_stage' };
    if (pet.stage_day >= this.day) return { code: 'stage_today' };
    pet.stage = stage;
    pet.stage_day = this.day;
    pet.traits.push(trait);
    this.grows.push({ token_id: tokenId, stage, trait });
    return null;
  }

  /** The contract's `riddle_commit`, in its order of checks: the caller, the hash, the day's commit, the reserve. */
  commit(caller: string, hash: string): { code: string } | null {
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    if (!/^[0-9a-f]{64}$/i.test(hash)) return { code: 'bad_hash' };
    if (this.commitFails !== null) return { code: this.commitFails };
    if (this.riddleCommits.has(this.day)) return { code: 'commit_today' };
    if (this.riddleReserve < RIDDLE_COMMIT_COST) return { code: 'reserve_empty' };
    this.riddleReserve -= RIDDLE_COMMIT_COST;
    this.riddleCommits.set(this.day, hash.toLowerCase());
    this.commits.push({ day: this.day, hash: hash.toLowerCase() });
    return null;
  }

  /** The contract's `riddle_reveal`, in its order of checks: the caller, the day, the commit, the hash. */
  async reveal(caller: string, day: number, riddle: string, answers: string[], salt: string): Promise<{ code: string } | null> {
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    if (this.revealFails !== null) return { code: this.revealFails };
    if (day >= this.day) return { code: 'reveal_too_early' };
    const hash = this.riddleCommits.get(day);
    if (hash === undefined) return { code: 'no_commit' };
    if ((await riddleHash(day, riddle, answers, salt)) !== hash) return { code: 'bad_reveal' };
    this.riddleCommits.delete(day);
    this.riddleReserve += RIDDLE_COMMIT_COST;
    this.reveals.push({ day, riddle, answers, salt });
    return null;
  }

  /** The contract's `streak_mark`, in its order of checks: the caller, the pet, the window, the day, the
   * skipped days. The arithmetic is written out here on its own, not taken from the Worker's. */
  mark(caller: string, tokenId: string, day: number, skipped: number): { code: string } | { spent: number } {
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    const pet = this.pets.get(tokenId);
    if (!pet) return { code: 'no_pet' };
    if (this.markFails !== null) return { code: this.markFails };
    const birthDay = Math.floor(pet.born_at / 86_400e9);
    if (day > this.day || day + 1 < this.day || day < birthDay) return { code: 'bad_day' };
    const last = pet.last_streak_day ?? 0;
    if (last !== 0 && day <= last) return { code: 'day_marked' };
    if (last !== 0 && skipped > day - last - 1) return { code: 'too_many_skipped' };
    let spent = 0;
    if (last === 0) {
      pet.streak = 1;
    } else {
      const missed = day - last - 1 - skipped;
      if (missed <= pet.freezes) {
        pet.freezes -= missed;
        pet.streak += 1;
        spent = missed;
      } else {
        spent = pet.freezes;
        pet.streak = 1;
        pet.freezes = 0;
      }
    }
    if (pet.streak % 7 === 0) pet.freezes = Math.min(255, pet.freezes + 1);
    // The streak's item goes in with the same write (`Earned outfit contract` › «вещь за серию записана»).
    const streakItem = pet.streak === 1 ? 0 : pet.streak === 3 ? 1 : null;
    if (streakItem !== null && !pet.outfits.includes(streakItem)) pet.outfits = [...pet.outfits, streakItem].sort((a, b) => a - b);
    pet.last_streak_day = day;
    this.marks.push({ token_id: tokenId, day, skipped, streak: pet.streak, freezes: pet.freezes, spent });
    return { spent };
  }

  /** The contract's `outfit_grant`, in its order of checks: the caller, the pet, the day after birth,
   * the item not yet there. The Thinking cap is item 2. */
  grant(caller: string, tokenId: string): { code: string } | null {
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    const pet = this.pets.get(tokenId);
    if (!pet) return { code: 'no_pet' };
    if (this.grantFails !== null) return { code: this.grantFails };
    if (this.day <= Math.floor(pet.born_at / 86_400e9)) return { code: 'outfit_too_early' };
    if (pet.outfits.includes(2)) return { code: 'outfit_owned' };
    pet.outfits = [...pet.outfits, 2].sort((a, b) => a - b);
    this.grants.push({ token_id: tokenId });
    return null;
  }

  /** The contract's `outfit_buy`, in its order of checks: the caller, the item is for sale, the pet,
   * the item not yet there, the daily cap, the food (project food first). */
  buy(caller: string, tokenId: string, item: number): { code: string } | null {
    if (caller !== env.SERVER_ACCOUNT_ID) return { code: 'not_server' };
    if (item < 3 || item > 6) return { code: 'not_for_sale' };
    const pet = this.pets.get(tokenId);
    if (!pet) return { code: 'no_pet' };
    if (pet.outfits.includes(item)) return { code: 'outfit_owned' };
    if (this.buyFails !== null) return { code: this.buyFails };
    const price = BigInt(env.OUTFIT_PRICE);
    const already = pet.debit_day === this.day ? BigInt(pet.debited_today) : 0n;
    if (already + price > 50_000_000_000_000_000_000_000n) return { code: 'daily_cap' };
    const project = BigInt(pet.project_food);
    const given = BigInt(pet.given_food);
    if (price > project + given) return { code: 'over_food' };
    const fromProject = price < project ? price : project;
    pet.project_food = (project - fromProject).toString();
    pet.given_food = (given - (price - fromProject)).toString();
    pet.debit_day = this.day;
    pet.debited_today = (already + price).toString();
    pet.outfits = [...pet.outfits, item].sort((a, b) => a - b);
    this.treasury += price;
    this.buys.push({ token_id: tokenId, item, price: price.toString() });
    return null;
  }

  /** Every accepted `debit_session`. */
  debits: { tokenId: string; debitId: number; thoughts: FakeThought[] }[] = [];

  /** Executes a signed transaction the Worker sent; returns the RPC answer or throws a network error. */
  private async deliver(base64: string): Promise<unknown> {
    const signed = decodeSignedTransaction(Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0)));
    const tx = signed.transaction;
    const action = tx.actions[0] as unknown as {
      functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
      transfer?: { deposit: bigint };
    };
    // A call of the contract, or a plain transfer (the gas account topping a wallet up).
    const call = action.functionCall ?? { methodName: 'transfer', args: new TextEncoder().encode(JSON.stringify({ receiver: tx.receiverId })), gas: 0n, deposit: action.transfer?.deposit ?? 0n };
    const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>))) as Record<string, unknown>;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encodeTransaction(tx)));
    // the same signed transaction may be delivered again by the RPC client's own retry: one attempt
    const sentHash = baseEncode(hash);
    if (!this.signedHashes.has(sentHash)) {
      this.signedHashes.add(sentHash);
      this.attempts += 1;
    }

    if (this.sendGate !== null) await this.sendGate;
    if (this.mode === 'nonce-once' && !this.nonceRejected) {
      this.nonceRejected = true;
      // The key's nonce on the chain is the `ak_nonce` of the answer below: the next read of it, and so the
      // transaction signed again, carries a higher one (a new transaction, a new hash).
      this.nonce = Number(tx.nonce) + 5;
      // nearcore's answer to a transaction with a stale nonce (JSON-RPC send_tx).
      return invalidTx({ InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: Number(tx.nonce) + 5 } });
    }
    if (this.mode === 'invalid-nonce') return invalidTx({ InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: Number(tx.nonce) + 5 } });
    if (this.mode === 'not-enough-balance') return invalidTx({ NotEnoughBalance: { signer_id: tx.signerId, balance: '1', cost: '2' } });
    if (this.mode === 'lost') throw new TypeError('Failed to fetch');
    // A signer that cannot pay the deposit is refused before anything runs (the server's own
    // balance is `serverBalance`, which the tests of the pause move).
    const pays = tx.signerId !== env.SERVER_ACCOUNT_ID && this.outcomes.get(baseEncode(hash)) === undefined;
    if (pays && (this.balances.get(tx.signerId) ?? 0n) < call.deposit) {
      return invalidTx({ NotEnoughBalance: { signer_id: tx.signerId, balance: (this.balances.get(tx.signerId) ?? 0n).toString(), cost: call.deposit.toString() } });
    }

    const key = baseEncode(hash);
    let outcome = this.outcomes.get(key);
    if (outcome === undefined && !this.applied.has(key)) {
      this.applied.add(key);
      if (tx.signerId !== env.SERVER_ACCOUNT_ID && tx.signerId !== env.GAS_ACCOUNT_ID) this.playerNonces.set(tx.signerId, Number(tx.nonce));
      this.sends.push({ method: call.methodName, args, gas: call.gas.toString(), deposit: call.deposit.toString(), signer: tx.signerId, nonce: Number(tx.nonce) });
      let status: unknown;
      if (call.methodName === 'pet_mint') {
        const result = this.mint(String(args.receiver), String(args.name), String(args.character));
        status =
          'code' in result
            ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${result.code}` } } } } }
            : { SuccessValue: btoa(JSON.stringify(result.tokenId)) };
      } else if (call.methodName === 'debit_session') {
        const refused = this.debit(String(args.token_id), Number(args.debit_id), args.thoughts as FakeThought[]);
        status = refused
          ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${refused.code}` } } } } }
          : { SuccessValue: '' };
      } else if (call.methodName === 'pet_feed') {
        const result = this.feed(tx.signerId, String(args.token_id), call.deposit);
        if ('code' in result) {
          status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${result.code}` } } } } };
        } else {
          this.balances.set(tx.signerId, (this.balances.get(tx.signerId) ?? 0n) - call.deposit);
          status = { SuccessValue: btoa(JSON.stringify(result.wrote)) };
        }
      } else if (call.methodName === 'nft_transfer') {
        const pet = this.pets.get(String(args.token_id));
        const receiver = String(args.receiver_id);
        const refused = pet === undefined ? 'no_pet' : pet.owner_id !== tx.signerId ? 'not_owner'
          : receiver === tx.signerId ? 'same_owner' : call.deposit !== 1n ? 'one_yocto'
            : args.memo !== null ? 'memo' : null;
        if (refused !== null) {
          status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${refused}` } } } } };
        } else {
          pet!.owner_id = receiver;
          this.balances.set(tx.signerId, (this.balances.get(tx.signerId) ?? 0n) - 1n);
          status = { SuccessValue: '' };
        }
      } else if (call.methodName === 'pet_snack') {
        const result = this.snack(tx.signerId, String(args.token_id), String(args.feeder), String(args.kind));
        status =
          'code' in result
            ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${result.code}` } } } } }
            : { SuccessValue: btoa(JSON.stringify(result.wrote)) };
      } else if (call.methodName === 'pet_grow') {
        const refused = this.grow(tx.signerId, String(args.token_id), String(args.stage), String(args.trait));
        status = refused
          ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${refused.code}` } } } } }
          : { SuccessValue: '' };
      } else if (call.methodName === 'outfit_grant' || call.methodName === 'outfit_buy') {
        const refused =
          call.methodName === 'outfit_grant'
            ? this.grant(tx.signerId, String(args.token_id))
            : this.buy(tx.signerId, String(args.token_id), Number(args.item));
        status = refused
          ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${refused.code}` } } } } }
          : { SuccessValue: '' };
      } else if (call.methodName === 'riddle_commit' || call.methodName === 'riddle_reveal' || call.methodName === 'streak_mark') {
        const refused =
          call.methodName === 'riddle_commit'
            ? this.commit(tx.signerId, String(args.hash))
            : call.methodName === 'riddle_reveal'
              ? await this.reveal(tx.signerId, Number(args.day), String(args.riddle), args.answers as string[], String(args.salt))
              : this.mark(tx.signerId, String(args.token_id), Number(args.day), Number(args.skipped));
        status =
          refused !== null && 'code' in refused
            ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${refused.code}` } } } } }
            : { SuccessValue: '' };
      } else if (call.methodName === 'transfer') {
        if (this.transferFails !== null) {
          status = { Failure: { ActionError: { index: 0, kind: { LackBalanceForState: { amount: this.transferFails } } } } };
        } else {
          this.balances.set(tx.signerId, (this.balances.get(tx.signerId) ?? 0n) - call.deposit);
          this.balances.set(tx.receiverId, (this.balances.get(tx.receiverId) ?? 0n) + call.deposit);
          status = { SuccessValue: '' };
        }
      } else {
        status = { SuccessValue: '' };
      }
      outcome = {
        final_execution_status: 'EXECUTED_OPTIMISTIC',
        status,
        transaction: { hash: key, signer_id: tx.signerId },
        transaction_outcome: { id: key, block_hash: BLOCK_HASH, outcome: { tokens_burnt: this.burnt } },
        receipts_outcome: [{ block_hash: BLOCK_HASH, outcome: { tokens_burnt: '0' } }],
      };
      this.outcomes.set(key, outcome);
    }
    if (this.mode === 'executed-but-silent') throw new TypeError('Failed to fetch');
    return { result: outcome };
  }

  private async during(call: keyof FakeContract['meanwhile']): Promise<void> {
    const work = this.meanwhile[call];
    delete this.meanwhile[call];
    await work?.();
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'query': {
        const type = params.request_type;
        if (type === 'call_function') {
          const args = JSON.parse(atob(String(params.args_base64))) as Record<string, unknown>;
          if (params.method_name === 'pet_view') await this.during('pet_view');
          const value = this.view(String(params.method_name), args);
          const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
          return { result: { result: bytes, logs: [], block_height: 1000, block_hash: BLOCK_HASH } };
        }
        if (type === 'view_access_key') {
          const account = String(params.account_id);
          if (account !== env.SERVER_ACCOUNT_ID && !this.balances.has(account)) return unknownAccount(account);
          return { result: { nonce: this.playerNonces.get(account) ?? this.nonce, permission: 'FullAccess', block_height: 1000, block_hash: BLOCK_HASH } };
        }
        if (type === 'view_account') {
          await this.during('view_account');
          const account = String(params.account_id);
          this.viewed.push(account);
          const amount = account === env.SERVER_ACCOUNT_ID ? this.serverBalance : this.balances.get(account);
          if (amount === undefined) return unknownAccount(account);
          return {
            result: {
              amount: amount.toString(),
              locked: '0',
              code_hash: '11111111111111111111111111111111',
              storage_usage: 100,
              storage_paid_at: 0,
              block_height: 1000,
              block_hash: BLOCK_HASH,
            },
          };
        }
        throw new Error(`the fake RPC has no query ${String(type)}`);
      }
      case 'block':
        if (this.blockBlind && params.block_id !== undefined) return { error: { name: 'HANDLER_ERROR', code: -32000, message: 'Unknown block' } };
        return { result: { header: { hash: BLOCK_HASH, height: params.block_id === undefined ? this.blockHeight : 1000, timestamp_nanosec: (BigInt(this.blockTimestampMs ?? Date.now()) * 1_000_000n).toString() } } };
      case 'send_tx':
        await this.during('send_tx');
        return await this.deliver(String(params.signed_tx_base64));
      case 'tx': {
        const outcome = this.txBlind ? undefined : this.outcomes.get(String(params.tx_hash));
        if (outcome === undefined) {
          if (this.unseenTx === 'timeout') return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR', info: {} }, code: -32000, message: 'Server error', data: 'Timeout' } };
          return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: { requested_transaction_hash: params.tx_hash } }, code: -32000, message: 'Server error', data: 'unknown transaction' } };
        }
        return { result: outcome };
      }
      default:
        throw new Error(`the fake RPC has no method ${method}`);
    }
  }
}


/** What the next call of NEAR AI Cloud does. Anything not given is an ordinary short reply. */
export interface AiBehavior {
  /** HTTP status; 402 is the spend limit or the empty balance, 429 the rate limit. */
  status?: number;
  /** The `content` of the answer; `</think>` inside it ends the reasoning. `null` is allowed by the OpenAI shape. */
  content?: string | null;
  finish?: 'stop' | 'length';
  tokensIn?: number;
  tokensOut?: number;
  reasoning?: number;
  /** The wait ran out: `fetch` fails the way an aborted request does. */
  hang?: boolean;
  /** The first N signature requests are a 404 (the signature is not ready yet). */
  signatureLate?: number;
  /** How the signature endpoint answers: the right `provider_tee`, a `gateway`, or a wrong `text`. */
  signature?: 'ok' | 'gateway' | 'mismatch' | 'never' | 'tee';
  /** The answer takes this long (ms) to come: a second request can arrive while it is in flight. */
  delay?: number;
  /** Runs while the call is in flight, before it answers: what the world does while the pet thinks
   * (the clock reaching 00:00 UTC, the owner's page, another desk). */
  during?: () => void | Promise<void>;
  /** The model asks for these functions (`tools` in the request): `tool_calls` as NEAR AI answers them, `content: null`
   * (recorded 2026-11-03, `.claude/handoff/recordings/README.md` › tools-*). `arguments` is the raw JSON text. */
  toolCalls?: { name: string; arguments: string }[];
  /** The call is a streamed search call (`stream: true`, the errand's): what the stream carries. `tokensIn` and
   * `tokensOut` are the closing `usage` of the whole call. */
  stream?: StreamBehavior;
}

/** A streamed answer of NEAR AI Cloud with its server-side web search (recorded 2026-11-03,
 * `.claude/handoff/recordings/README.md`): a tool call (its id, then the query), its result, and so on for each search,
 * then the answer, a last chunk with `usage` and `[DONE]`. */
export interface StreamBehavior {
  /** How many searches the model runs; 0 answers without searching. Default 1. */
  searches?: number;
  /** Results in each search's output. Default 3. */
  results?: number;
  /** The raw output of each search, instead of the made-up results. */
  outputs?: string[];
  /** The closing `usage` chunk is left out. */
  noUsage?: boolean;
  /** The model starts this many searches at once, before any result (parallel tool calls). */
  parallel?: number;
  /** The stream breaks after this many events (the connection drops). */
  breakAfter?: number;
}

/** What became of a streamed call: how many events the Worker took from it, and whether it hung up. */
export interface StreamRecord {
  total: number;
  delivered: number;
  cancelled: boolean;
}

export interface AiCall {
  url: string;
  headers: Record<string, string>;
  reqBytes: Uint8Array;
  /** `nonce`: the random field of a skilled worker's request (`Skilled answer data`), outside `messages`. */
  body: {
    model: string;
    messages: { role: string; content: string }[];
    max_tokens: number;
    stream: boolean;
    chat_template_kwargs: { enable_thinking: boolean };
    nonce?: string;
    tools?: unknown;
    tool_choice?: unknown;
    stream_options?: unknown;
  };
}

const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** NEAR AI Cloud as the Worker meets it: a chat completion whose answer bytes are NOT canonical JSON
 * (indented, a trailing newline), so a Worker that hashed a re-serialized object would sign
 * different bytes; and a signature endpoint whose `text` is made from the bytes it really saw. */
export class FakeNearAi {
  calls: AiCall[] = [];
  signatureRequests: string[] = [];
  probes = 0;
  /** Calls in flight now and the most there ever were at once. */
  active = 0;
  peak = 0;
  probeStatus = 200;
  /** Behaviors for the next calls in order; when empty, the default. */
  script: AiBehavior[] = [];
  /** The answers leave this field out. */
  broken: { usage?: boolean } = {};
  /** One record for each streamed call. */
  streams: StreamRecord[] = [];
  private seen = new Map<string, { req: string; res: string; behavior: AiBehavior; asked: number }>();
  private n = 0;

  push(...behaviors: AiBehavior[]): void {
    this.script.push(...behaviors);
  }

  async chat(url: string, headers: Record<string, string>, reqBytes: Uint8Array, signal?: AbortSignal | null): Promise<Response> {
    const body = JSON.parse(new TextDecoder().decode(reqBytes)) as AiCall['body'];
    this.calls.push({ url, headers, reqBytes, body });
    const b = this.script.shift() ?? {};
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      if (b.delay) await new Promise((resolve) => setTimeout(resolve, b.delay));
      await b.during?.();
      return body.stream === true ? await this.streamAnswer(b, body, reqBytes, signal ?? undefined) : await this.answer(b, body, reqBytes);
    } finally {
      this.active -= 1;
    }
  }

  private async answer(b: AiBehavior, body: AiCall['body'], reqBytes: Uint8Array): Promise<Response> {
    if (b.hang) throw new DOMException('The operation was aborted', 'AbortError');
    if (b.status !== undefined && b.status !== 200) {
      return Response.json({ error: { message: 'refused', type: 'x', param: null, code: null } }, { status: b.status });
    }
    this.n += 1;
    const id = `chatcmpl-test-${this.n}`;
    const tokensIn = b.tokensIn ?? Math.ceil(reqBytes.length / 4);
    const asked = b.toolCalls !== undefined && b.toolCalls.length > 0;
    const finish = asked ? 'tool_calls' : (b.finish ?? 'stop');
    const tokensOut = b.tokensOut ?? (finish === 'length' ? body.max_tokens : 30);
    const message = asked
      ? {
          role: 'assistant',
          content: null,
          tool_calls: b.toolCalls!.map((call, i) => ({ id: `call_${this.n}_${i}`, type: 'function', function: { name: call.name, arguments: call.arguments } })),
        }
      : { role: 'assistant', content: b.content === undefined ? 'Hello there, friend.' : b.content };
    const answer = {
      id,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finish }],
      ...(this.broken.usage ? {} : { usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, completion_tokens_details: { reasoning_tokens: b.reasoning ?? 0 } } }),
    };
    // Indented with a trailing newline: not what JSON.stringify(JSON.parse(x)) gives back.
    const resBytes = new TextEncoder().encode(`${JSON.stringify(answer, null, 1)}\n`);
    this.seen.set(id, { req: await sha(reqBytes), res: await sha(resBytes), behavior: b, asked: 0 });
    return new Response(resBytes, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** The streamed answer of the search call, event by event; the Worker may hang up on it (`reader.cancel()`). */
  private async streamAnswer(b: AiBehavior, body: AiCall['body'], reqBytes: Uint8Array, signal?: AbortSignal): Promise<Response> {
    if (b.hang) throw new DOMException('The operation was aborted', 'AbortError');
    if (b.status !== undefined && b.status !== 200) {
      return Response.json({ error: { message: 'refused', type: 'x', param: null, code: null } }, { status: b.status });
    }
    this.n += 1;
    const id = `chatcmpl-test-${this.n}`;
    const sb = b.stream ?? {};
    const searches = sb.searches ?? 1;
    const chunk = (delta: object, extra: object = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, ...extra }], usage: null })}\n\n`;
    const events: string[] = [chunk({ role: 'assistant', content: '' })];
    if (sb.parallel !== undefined) {
      // every id shows first, the results only after them
      for (let i = 0; i < sb.parallel; i += 1) {
        events.push(chunk({ tool_calls: [{ id: `call_${this.n}_p${i}`, type: 'function', index: i, function: { name: 'web_context_search', arguments: '' } }] }));
      }
      events.push(chunk({}, { finish_reason: 'tool_calls' }));
      for (let i = 0; i < sb.parallel; i += 1) {
        events.push(chunk({ nearai_tool_result: { tool_call_id: `call_${this.n}_p${i}`, name: 'web_context_search', status: 'ok', output: `[1] Parallel ${i}\nhttps://p${i}.example.com/x\nText` } }));
      }
    }
    for (let i = 0; i < (sb.parallel !== undefined ? 0 : searches); i += 1) {
      const call = `call_${this.n}_${i}`;
      const output =
        sb.outputs?.[i] ??
        Array.from({ length: sb.results ?? 3 }, (_, k) => `[${k + 1}] Title ${i + 1}.${k + 1}\nhttps://www.site${i + 1}${k + 1}.example.com/page\nBody of result ${i + 1}.${k + 1}. ${'text '.repeat(40)}`).join('\n\n');
      events.push(
        chunk({ tool_calls: [{ id: call, type: 'function', index: 0, function: { name: 'web_context_search', arguments: '' } }] }),
        chunk({ tool_calls: [{ type: 'function', index: 0, function: { arguments: `{"query": "query ${i + 1}"}` } }] }),
        chunk({}, { finish_reason: 'tool_calls' }),
        chunk({ nearai_tool_result: { tool_call_id: call, name: 'web_context_search', status: 'ok', output } }),
      );
    }
    events.push(chunk({ role: 'assistant', content: '' }), chunk({ content: 'An answer.' }), chunk({}, { finish_reason: 'stop' }));
    if (!sb.noUsage) {
      events.push(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: b.tokensIn ?? 5_000 * searches + 1_000, completion_tokens: b.tokensOut ?? 45, total_tokens: 0, completion_tokens_details: { reasoning_tokens: b.reasoning ?? 0 } } })}\n\n`,
      );
    }
    events.push('data: [DONE]\n\n');
    const bytes = events.map((e) => new TextEncoder().encode(e));
    const all = new Uint8Array(bytes.reduce((n, e) => n + e.length, 0));
    let at = 0;
    for (const e of bytes) {
      all.set(e, at);
      at += e.length;
    }
    const record: StreamRecord = { total: bytes.length, delivered: 0, cancelled: false };
    this.streams.push(record);
    this.seen.set(id, { req: await sha(reqBytes), res: await sha(all), behavior: b, asked: 0 });
    let next = 0;
    const body$ = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Promise.resolve();
        if (signal?.aborted) return controller.error(new DOMException('The operation was aborted', 'AbortError'));
        if (sb.breakAfter !== undefined && next >= sb.breakAfter) return controller.error(new TypeError('network connection lost'));
        if (next >= bytes.length) return controller.close();
        controller.enqueue(bytes[next]!);
        next += 1;
        record.delivered = next;
      },
      cancel() {
        record.cancelled = true;
      },
    });
    return new Response(body$, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  signature(id: string): Response {
    this.signatureRequests.push(id);
    const known = this.seen.get(id);
    if (!known || known.behavior.signature === 'never') return Response.json({ error: { message: 'not found' } }, { status: 404 });
    known.asked += 1;
    if (known.asked <= (known.behavior.signatureLate ?? 0)) return Response.json({ error: { message: 'not found' } }, { status: 404 });
    // A streamed call is signed by the gateway over `<req>:<res>`, with no model in the text (recorded 2026-11-03).
    const streamed = known.behavior.stream !== undefined;
    const kind = streamed ? (known.behavior.signature === 'tee' ? 'provider_tee' : 'gateway') : known.behavior.signature === 'gateway' ? 'gateway' : 'provider_tee';
    const res = known.behavior.signature === 'mismatch' ? '0'.repeat(64) : known.res;
    const text = streamed ? `${known.req}:${res}` : `Qwen/Qwen3.8-27B:${known.req}:${res}`;
    return Response.json({ text, signature: `0xsig-${id}`, signing_address: '0xsigner', signing_algo: 'ecdsa', signature_kind: kind });
  }

  /** The hashes of the request and the answer the fake saw for a completion id. */
  hashes(id: string): { req: string; res: string } | undefined {
    const k = this.seen.get(id);
    return k && { req: k.req, res: k.res };
  }
}

/** A page of the fake web: what a link of «Read this» leads to. */
export interface FakePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** The page never answers: `fetch` fails the way an aborted request does. */
  hang?: boolean;
}

/** The web as the Worker meets it: pages by normalized URL. The DNS map models the address Cloudflare's egress
 * resolves for a fetch, including a private address it cannot reach. No separate DNS request is made by the Worker. */
export class FakeWeb {
  pages = new Map<string, FakePage>();
  dns = new Map<string, { a?: string[]; aaaa?: string[]; fail?: boolean }>();
  /** Every page request the Worker made: its URL and the headers it sent. */
  requests: { url: string; headers: Record<string, string> }[] = [];

  page(url: string, page: FakePage = {}): void {
    this.pages.set(new URL(url).href, page);
  }

  redirect(from: string, to: string, status = 302): void {
    this.page(from, { status, headers: { location: to }, body: '' });
  }

  /** Servers that answer a request of any method at a URL (an MCP server answers POSTs): the request as it came. */
  handlers = new Map<string, (req: { method: string; url: string; headers: Record<string, string>; body: string }) => Response | Promise<Response>>();

  async handle(url: string, init?: RequestInit): Promise<Response | null> {
    const handler = this.handlers.get(url);
    if (handler === undefined) return null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    return handler({ method: init?.method ?? 'GET', url, headers, body: typeof init?.body === 'string' ? init.body : '' });
  }

  serve(url: string, init?: RequestInit): Response | null {
    const page = this.pages.get(url);
    if (page === undefined) return null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    this.requests.push({ url, headers });
    if (page.hang) throw new DOMException('The operation was aborted', 'AbortError');
    const status = page.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : (page.body ?? ''), { status, headers: { 'content-type': 'text/html; charset=utf-8', ...page.headers } });
  }
}

const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));

const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

export interface TokenOptions {
  expiresIn?: string;
  audience?: string;
  issuer?: string;
  kid?: string;
  /** Privy's session id claim; default `sid:<sub>`, `null` leaves the claim out. */
  sid?: string | null;
  /** The token is made for a player the server has no row of (a refusal's test, a sign-in's first call). */
  noPlayer?: boolean;
  /** The Google name in the token; default `Test Player`, `null` leaves the Google entry out. */
  name?: string | null;
}

/** An identity token as Privy would issue it for `sub`, carrying a NEAR embedded wallet. Unless
 * `noPlayer`, the player has a row of this month, as one who passed the exchange of `POST /api/session`. */
export async function token(sub: string, accountId: string, opts: TokenOptions = {}): Promise<string> {
  if (opts.noPlayer !== true) {
    await env.DB.prepare('INSERT OR IGNORE INTO players (sub, account_id, month, created_at) VALUES (?, ?, ?, ?)')
      .bind(sub, accountId, new Date().toISOString().slice(0, 7), Date.now())
      .run();
  }
  const sid = opts.sid === undefined ? `sid:${sub}` : opts.sid;
  return new SignJWT({
    ...(sid === null ? {} : { sid }),
    linked_accounts: JSON.stringify([
      ...(opts.name === null ? [] : [{ type: 'google_oauth', subject: 'g-1', name: opts.name ?? 'Test Player' }]),
      { type: 'wallet', chain_type: 'near', address: accountId, wallet_client_type: 'privy' },
    ]),
  })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'test-key' })
    .setIssuer(opts.issuer ?? 'privy.io')
    .setAudience(opts.audience ?? env.PRIVY_APP_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
}

export interface Network {
  contract: FakeContract;
  ai: FakeNearAi;
  web: FakeWeb;
  /** Every URL fetched, for "nothing left the Worker" assertions. */
  fetched: string[];
  /** Privy's key set answers with this status (0: the fetch itself fails). */
  jwks: { status: number };
  restore: () => void;
}

/** Replaces `fetch` for the test. Call `restore()` (or use `afterEach`) when done. */
export function installNetwork(): Network {
  const contract = new FakeContract();
  const ai = new FakeNearAi();
  const web = new FakeWeb();
  const fetched: string[] = [];
  const jwks = { status: 200 };
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    if (url === env.PRIVY_JWKS_URL) {
      if (jwks.status === 0) throw new TypeError('Failed to fetch');
      return jwks.status === 200 ? Response.json({ keys: [publicJwk] }) : new Response('unavailable', { status: jwks.status });
    }
    if (url === env.NEAR_RPC_URL) {
      if (contract.down) return new Response('unavailable', { status: 503 });
      const request = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))) as { id: string; method: string; params: Record<string, unknown> };
      const answer = (await contract.handle(request.method, request.params)) as { result?: unknown; error?: unknown };
      return Response.json({ jsonrpc: '2.0', id: request.id, ...answer });
    }
    if (url.startsWith('https://cloud-api.near.ai/v1/')) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      if (url.endsWith('/chat/completions')) return ai.chat(url, headers, init?.body as Uint8Array, init?.signal);
      if (url.includes('/signature/')) return ai.signature(decodeURIComponent(url.split('/signature/')[1]!.split('?')[0]!));
      if (url.endsWith('/check_api_key')) {
        ai.probes += 1;
        return ai.probeStatus === 200 ? Response.json({ valid: true }) : Response.json({ error: { message: 'x', type: 'x', param: null, code: null } }, { status: ai.probeStatus });
      }
    }
    const host = new URL(url).hostname;
    const resolved = web.dns.get(host);
    if (resolved?.fail || (resolved !== undefined && [...(resolved.a ?? []), ...(resolved.aaaa ?? [])].some(isPrivateAddress))) {
      throw new TypeError('Cloudflare egress cannot reach this address');
    }
    const handled = await web.handle(url, init);
    if (handled !== null) return handled;
    const page = web.serve(url, init);
    if (page !== null) return page;
    throw new Error(`a test must not reach the network: ${url}`);
  });
  return { contract, ai, web, fetched, jwks, restore: () => spy.mockRestore() };
}

/** A player whose game wallet has a real key: the account id is the 64 hex characters of the public
 * key (an implicit account), and `sign` does what Privy does in the browser: signs `sha256(tx)`. */
export function keyedPlayer(): { account: string; sign: (tx: string) => Promise<{ tx: string; signature: string }> } {
  const pair = KeyPairEd25519.fromRandom();
  const publicKey = pair.getPublicKey();
  const account = [...publicKey.ed25519Key!.data].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    account,
    async sign(tx) {
      const bytes = Uint8Array.from(atob(tx), (ch) => ch.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { tx, signature: btoa(String.fromCharCode(...pair.sign(digest).signature)) };
    },
  };
}

export { baseDecode };
