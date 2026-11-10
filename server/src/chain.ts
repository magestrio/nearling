// The Worker's reads of the NEAR contract and the transactions of the server's key.
//
// Reads (`pet_view`, `hatch_view`, `nft_supply_for_owner`, balances, a transaction's status) are
// plain JSON-RPC through near-api-js; a failure of the network is `ChainUnreachable` (the routes
// answer 503, nothing is served or accepted). The transactions of the server's key go through the
// `ServerKey` Durable Object, one at a time (`src/do/serverKey.ts`), and use `signAndSend` below.
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  PublicKey,
  actions,
  baseDecode,
  baseEncode,
  encodeTransaction,
  type Action,
  type KeyPairString,
  type SignedTransaction,
} from 'near-api-js';
import {
  AccessKeyDoesNotExistError,
  AccountDoesNotExistError,
  InvalidNonceError,
  InvalidTransactionError,
  NotEnoughBalanceError,
  TransactionExecutionError,
} from 'near-api-js/rpc-errors';

export class ChainUnreachable extends Error {
  constructor(message = 'chain_unreachable') {
    super(message);
    this.name = 'ChainUnreachable';
  }
}

/** The pet as `pet_view` returns it. Amounts are decimal strings; `born_at` is nanoseconds and
 * loses precision as a JS number, so nothing here reads it. */
export interface PetRecord {
  owner_id: string;
  name: string;
  character: string;
  born_at: number;
  project_food: string;
  given_food: string;
  /** Public food set aside for the pet's private wish. */
  wish_reserve?: string;
  wish_active?: boolean;
  debit_day: number;
  debited_today: string;
  last_debit_id: number;
  /** `Stage` of the contract, as near-sdk writes it: `"Baby"`. The client's word comes from `stageOf`. */
  stage: string;
  stage_day: number;
  streak: number;
  freezes: number;
  /** The UTC day of the friends' snack counter and how many snacks friends gave that day (a counter of
   * an earlier day reads 0). */
  friend_snack_day: number;
  friend_snacks: number;
  /** When the owner's last snack was given, ns, as a decimal string (`U64`); `"0"` = never. */
  owner_snack_at: string;
  /** The traits in the order they were gained, a repeat shown twice (`["clever","clever"]`). */
  traits: Trait[];
  /** The UTC day of the last streak mark; `null` before the first one (`Option<u64>` of `PetView`). */
  last_streak_day: number | null;
  /** The ids of the outfit items the pet has, ascending (`Vec<u8>` of `PetView`): 0 Daisy crown … 6 Party hat. */
  outfits: number[];
  /** The token ids of the pets this one met through work, ascending (`Known pets contract`). Absent on a contract
   * that has not been upgraded: read it as none. */
  work_known?: string[];
  /** The jobs the pet did in the UTC day of its last one, 0 when that day is not today. */
  jobs_today?: number;
  /** Incremented by every nft_transfer, even when the owner later receives the pet back. */
  transfer_generation: number;
  /** Public active reserve from `pet_view`, absent before the shared-job contract upgrade. */
  shared_job?: {
    hash: string;
    state: 'Funding' | 'Running' | 'Transferred' | 'Settled';
    allowance: string;
    linked_near: string;
    linked_snack: string;
  } | null;
}

/** `riddle_view(day)` of the contract: the commit filed for that day (64 hex characters, `null` when
 * there is none or it was revealed), the commit-storage reserve and the price of one commit, yocto. */
export interface RiddleRecord {
  hash: string | null;
  reserve: string;
  commit_cost: string;
}

export type Stage = 'baby' | 'teen' | 'adult';

/** A trait as the contract's JSON spells it (`Trait` in `contract/src/pet.rs`), snake_case. */
export const TRAITS = ['clever', 'sociable', 'hard_working', 'thoughtful', 'cozy'] as const;
export type Trait = (typeof TRAITS)[number];

/** The stage in the word every answer to the client uses (the contract says `Baby`). */
export function stageOf(pet: Pick<PetRecord, 'stage'>): Stage {
  return pet.stage.toLowerCase() as Stage;
}

export interface HatchRecord {
  token_id: string | null;
  owned_count: string;
  day: number;
  born_today: number;
  pool: string;
}

/** Public `showcase_view` counters; the U128 amount is a decimal yoctoNEAR string. */
export interface ShowcaseNumbers {
  pets_hatched: number;
  thoughts_paid: number;
  spent: string;
  hires_completed: number;
  friend_snacks: number;
  /** Nanoseconds since Unix epoch; the contract's plain u64 JSON number. */
  counted_since: number;
}

/** Prepaid gas of `pet_mint`, Tgas. The mint's gas grows with the token tree: 8.58 Tgas burnt at most
 * over 260 births (`contract/tests/pet_mint.rs`, which reads this line and births them with it).
 * Unused gas is refunded. */
export const PET_MINT_TGAS = 15n;

/** Prepaid gas of `pet_feed`, Tgas: the player's wallet buys it up front at 0.001 NEAR/Tgas
 * (`Feeding gas data`). `contract/tests/feed.rs` › `gas_of_a_feed` reads this line and feeds with it. */
export const PET_FEED_TGAS = 5n;

/** Measured with a 64-character giver in contract/tests/gift_transfer.rs. */
export const GIFT_TRANSFER_TGAS = 5n;
/** 1.89 Tgas burnt by the longest open in contract/tests/shared_job.rs. */
export const SHARED_JOB_OPEN_TGAS = 5n;
export const GIFT_RESERVE_YOCTO = 6_000_000_000_000_000_000_001n;

/** The send and execution fees of a `pet_feed` transaction, Tgas, rounded up: the wallet buys them up
 * front on top of the prepaid gas (`contract/tests/feed.rs` reads this line and feeds with it). */
export const PET_FEED_FEES_TGAS = 1n;

/** Prepaid gas of `pet_snack`, Tgas; `contract/tests/snack.rs` › `gas_of_a_snack` reads this line. */
export const PET_SNACK_TGAS = 5n;

/** Prepaid gas of `pet_grow`, Tgas; `contract/tests/pet_grow.rs` › `gas_of_a_grow` reads this line
 * and grows the worst case with it. */
export const PET_GROW_TGAS = 5n;

/** Prepaid gas of `streak_mark`, Tgas; `contract/tests/streak_mark.rs` › `gas_of_a_mark` reads this
 * line and marks the worst cases with it. */
export const STREAK_MARK_TGAS = 5n;

/** Prepaid gas of `riddle_commit`, Tgas; `contract/tests/riddle.rs` › `gas_of_a_commit` reads this line. */
export const RIDDLE_COMMIT_TGAS = 5n;

/** Prepaid gas of `riddle_reveal`, Tgas; `contract/tests/riddle.rs` › `gas_of_a_reveal` reads this
 * line and reveals the longest list entry with it. */
export const RIDDLE_REVEAL_TGAS = 5n;

/** Prepaid gas of `outfit_grant`, Tgas; `contract/tests/outfit.rs` › `gas_of_a_grant` reads this line
 * and grants with it (2.05 Tgas burnt). */
export const OUTFIT_GRANT_TGAS = 5n;

/** Prepaid gas of `outfit_buy`, Tgas; `contract/tests/outfit.rs` › `gas_of_a_purchase` reads this line
 * and buys with it (2.75 Tgas burnt, the transfer to the treasury included). */
export const OUTFIT_BUY_TGAS = 5n;

const READ_TIMEOUT_MS = 8_000;
const SEND_TIMEOUT_MS = 25_000;
const SERVER_NONCE_RETRIES = 3;

export function rpcProvider(env: Pick<Env, 'NEAR_RPC_URL'>): JsonRpcProvider {
  // The library retries a 500, a 408 or a dropped fetch on its own; two quick attempts, then the
  // route says the network is unreachable.
  return new JsonRpcProvider({ url: env.NEAR_RPC_URL }, { retries: 2, wait: 200, backoff: 1 });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A bounded raw transaction read for receipt evidence. Unknown, slow and failed RPC calls fail closed. */
export async function receiptTransaction(env: Pick<Env, 'NEAR_RPC_URL'>, txHash: string, senderId: string): Promise<unknown> {
  try {
    return await withTimeout(rpcProvider(env).viewTransactionStatus({
      txHash, accountId: senderId, waitUntil: 'EXECUTED_OPTIMISTIC',
    }), READ_TIMEOUT_MS);
  } catch {
    throw new ChainUnreachable();
  }
}

async function view<T>(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, method: string, args: Record<string, unknown>): Promise<T> {
  try {
    const result = await withTimeout(rpcProvider(env).callFunction({ contractId: env.CONTRACT_ID, method, args }), READ_TIMEOUT_MS);
    return result as T;
  } catch {
    throw new ChainUnreachable();
  }
}

/** The pet and its owner, or null when the token does not exist. Never cached. */
export async function petView(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, tokenId: string): Promise<PetRecord | null> {
  return (await view<PetRecord | null | undefined>(env, 'pet_view', { token_id: tokenId })) ?? null;
}

export function hatchView(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, accountId: string): Promise<HatchRecord> {
  return view<HatchRecord>(env, 'hatch_view', { account_id: accountId });
}

export function showcaseView(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>): Promise<ShowcaseNumbers> {
  return view<ShowcaseNumbers>(env, 'showcase_view', {});
}

/** Word-free permanent paid-work counts, or null for an unknown NFT. */
export function experienceView(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, tokenId: string): Promise<{
  token_id: string; paid_hires: number; completed_errands: number; counted_since: number;
} | null> {
  return view(env, 'experience_view', { token_id: tokenId });
}

/** The chain's UTC day now: the contract's own `day_of(block_timestamp)`, which `hatch_view` returns
 * whichever account is asked (`pet-life` design.md › Chain time). One caller reads it for the counted
 * day; `ChainUnreachable` when it cannot be read, and the caller takes the Worker's clock. */
export async function chainDay(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID' | 'SERVER_ACCOUNT_ID'>): Promise<number> {
  return (await hatchView(env, env.SERVER_ACCOUNT_ID)).day;
}

/** The riddle commit of a UTC day and the reserve that pays for it (`riddle_view`). Never cached. */
export function riddleView(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, day: number): Promise<RiddleRecord> {
  return view<RiddleRecord>(env, 'riddle_view', { day });
}

/** The token ids of the pets the account owns now, at most `limit` (NEP-181 `nft_tokens_for_owner`). */
export async function tokenIdsOf(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, accountId: string, limit: number): Promise<string[]> {
  const tokens = await view<{ token_id: string }[]>(env, 'nft_tokens_for_owner', { account_id: accountId, from_index: null, limit });
  return tokens.map((t) => t.token_id);
}

/** Read every NEP-181 page. A short page is the end; token ids stay on chain. */
export async function allTokenIdsOf(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, accountId: string): Promise<string[]> {
  const ids: string[] = [];
  const pageSize = 50;
  for (;;) {
    const page = await view<{ token_id: string }[]>(env, 'nft_tokens_for_owner', {
      account_id: accountId,
      from_index: String(ids.length),
      limit: pageSize,
    });
    ids.push(...page.map((token) => token.token_id));
    if (page.length < pageSize) return [...new Set(ids)];
  }
}

/** Whether the pet's record of acquaintances holds the account (`pet_knows`): the truth the hire candidates rest on. */
export function petKnows(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, tokenId: string, accountId: string): Promise<boolean> {
  return view<boolean>(env, 'pet_knows', { token_id: tokenId, account_id: accountId });
}

/** How many pets the account owns now (NEP-181). */
export async function ownedCount(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, accountId: string): Promise<number> {
  const n = await view<string | number>(env, 'nft_supply_for_owner', { account_id: accountId });
  return Number(n);
}

/** The account's balance in yoctoNEAR, as a decimal string. */
export async function accountBalance(env: Pick<Env, 'NEAR_RPC_URL'>, accountId: string): Promise<string> {
  try {
    const account = await withTimeout(rpcProvider(env).viewAccount({ accountId }), READ_TIMEOUT_MS);
    return String(account.amount);
  } catch {
    throw new ChainUnreachable();
  }
}

/** The public fields of a named account for a daily watch, with the same read timeout as other RPC views. */
export async function publicAccountState(env: Pick<Env, 'NEAR_RPC_URL'>, accountId: string): Promise<{ amount: string; locked: string; code_hash: string; storage_usage: number }> {
  try {
    const account = await withTimeout(rpcProvider(env).viewAccount({ accountId }), READ_TIMEOUT_MS);
    return { amount: String(account.amount), locked: String(account.locked), code_hash: String(account.code_hash), storage_usage: account.storage_usage };
  } catch { throw new ChainUnreachable(); }
}

/** What the player's game wallet holds, yoctoNEAR. A wallet that does not exist is an empty one: a
 * new player's implicit account has no record until the first transfer reaches it, and every other
 * failure to read is `ChainUnreachable` (`accountBalance` keeps that for the project's own accounts). */
export async function walletBalance(env: Pick<Env, 'NEAR_RPC_URL'>, accountId: string): Promise<bigint> {
  try {
    const account = await withTimeout(rpcProvider(env).viewAccount({ accountId }), READ_TIMEOUT_MS);
    return BigInt(account.amount);
  } catch (e) {
    if (e instanceof AccountDoesNotExistError) return 0n;
    throw new ChainUnreachable();
  }
}

/** The nonce of the account's key now, or `null` when the key (or the account) does not exist. */
export async function accessKeyNonce(env: Pick<Env, 'NEAR_RPC_URL'>, accountId: string, publicKey: PublicKey | string): Promise<bigint | null> {
  try {
    const key = await withTimeout(rpcProvider(env).viewAccessKey({ accountId, publicKey: PublicKey.from(publicKey) }), READ_TIMEOUT_MS);
    return BigInt(key.nonce);
  } catch (e) {
    if (e instanceof AccessKeyDoesNotExistError || e instanceof AccountDoesNotExistError) return null;
    throw new ChainUnreachable();
  }
}

/** The hash of a final block, for the transaction's reference (the node has it in memory). */
export async function recentBlockHash(env: Pick<Env, 'NEAR_RPC_URL'>): Promise<Uint8Array> {
  try {
    const block = await withTimeout(rpcProvider(env).viewBlock({ finality: 'final' }), READ_TIMEOUT_MS);
    return baseDecode(block.header.hash);
  } catch {
    throw new ChainUnreachable();
  }
}

/** NEAR accepts a signed transaction while its reference block is within 86,400 blocks of the
 * final head. Compare block heights, not wall time, before treating an unseen hash as expired. */
export async function transactionExpired(env: Pick<Env, 'NEAR_RPC_URL'>, referenceHash: Uint8Array, createdAt: number): Promise<boolean> {
  try {
    const provider = rpcProvider(env);
    const head = await withTimeout(provider.viewBlock({ finality: 'final' }), READ_TIMEOUT_MS);
    try {
      const reference = await withTimeout(provider.viewBlock({ blockId: baseEncode(Uint8Array.from(referenceHash)) }), READ_TIMEOUT_MS);
      return Number(head.header.height) - Number(reference.header.height) > 86_400;
    } catch {
      // A non-archive RPC may have pruned the reference block. Give it two days before
      // treating an unseen hash as expired; a short RPC outage still leaves it unknown.
      if (Date.now() - createdAt >= 48 * 3_600_000) return true;
      throw new ChainUnreachable();
    }
  } catch {
    throw new ChainUnreachable();
  }
}

/** What the network says about a transaction we sent. `null`: the network has not seen it (yet). */
export type TxOutcome = { status: 'ok'; value: string | null; burnt?: string; blockHash?: string } | { status: 'failed'; code: string; burnt?: string } | { status: 'pending' } | null;

/** The execution block's timestamp, in milliseconds. Never use the Worker's clock as chain time. */
export async function blockTime(env: Pick<Env, 'NEAR_RPC_URL'>, hash: string): Promise<number> {
  try {
    const block = await withTimeout(rpcProvider(env).viewBlock({ blockId: hash }), READ_TIMEOUT_MS);
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  } catch {
    throw new ChainUnreachable();
  }
}

export async function txStatus(env: Pick<Env, 'NEAR_RPC_URL'>, txHash: string, senderId: string): Promise<TxOutcome> {
  try {
    const out = await withTimeout(rpcProvider(env).viewTransactionStatus({ txHash, accountId: senderId, waitUntil: 'EXECUTED_OPTIMISTIC' }), READ_TIMEOUT_MS);
    return interpret(out);
  } catch (e) {
    // Not an outage: the network did not take it. nearcore polls an unknown hash until its own
    // timeout, so `TIMEOUT_ERROR` (or our own wait running out first) is how a dropped transaction
    // usually answers. A real outage shows at the caller's next read of the contract.
    if (isNotKnownYet(e)) return null;
    throw new ChainUnreachable();
  }
}

/** A mint is settled only from its original FINAL transaction, with the recorded receiver. */
export async function finalBirthStatus(env: Pick<Env, 'NEAR_RPC_URL' | 'CONTRACT_ID'>, txHash: string, senderId: string, receiver: string): Promise<TxOutcome> {
  try {
    const raw = await withTimeout(rpcProvider(env).viewTransactionStatus({
      txHash, accountId: senderId, waitUntil: 'FINAL',
    }), READ_TIMEOUT_MS);
    if (raw.final_execution_status !== 'FINAL') return { status: 'pending' };
    const tx = raw.transaction;
    if (tx.signer_id !== senderId || tx.receiver_id !== env.CONTRACT_ID || tx.hash !== txHash) throw new ChainUnreachable();
    const actions = tx.actions as Array<{ FunctionCall?: { method_name: string; args: string } }>;
    if (actions.length !== 1 || actions[0]?.FunctionCall?.method_name !== 'pet_mint') throw new ChainUnreachable();
    const rawArgs = atob(actions[0].FunctionCall.args);
    const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(rawArgs, (ch) => ch.charCodeAt(0)))) as { receiver?: unknown };
    if (args.receiver !== receiver) throw new ChainUnreachable();
    if (raw.transaction_outcome?.outcome?.tokens_burnt === undefined ||
      raw.receipts_outcome === undefined ||
      raw.receipts_outcome.some((receipt) => receipt.outcome?.tokens_burnt === undefined)) throw new ChainUnreachable();
    return interpret(raw);
  } catch (e) {
    if (isNotKnownYet(e)) return null;
    throw new ChainUnreachable();
  }
}

/** Fresh protocol gas price, yoctoNEAR per gas unit, for a worst-case prepaid mint quote. */
export async function currentGasPrice(env: Pick<Env, 'NEAR_RPC_URL'>): Promise<bigint> {
  try {
    const quote = await withTimeout(rpcProvider(env).viewGasPrice(), READ_TIMEOUT_MS);
    const price = BigInt(quote.gas_price);
    if (price <= 0n) throw new Error('bad_gas_price');
    return price;
  } catch {
    throw new ChainUnreachable();
  }
}

function isNotKnownYet(e: unknown): boolean {
  const err = e as { type?: string; name?: string; message?: string } | null;
  return (
    err?.type === 'UnknownTransaction' ||
    err?.name === 'UnknownTransactionError' ||
    err?.name === 'TransactionTimeoutError' ||
    err?.message === 'Transaction timed out' ||
    err?.message === 'timeout'
  );
}

/** The refusal codes of the contract's panics (design.md › Контракт › Ошибки). */
const CONTRACT_CODES = [
  'not_server',
  'already_hatched',
  'already_owns_pet',
  'daily_births',
  'name_too_long',
  'character_too_long',
  'pool_empty',
  'birth_cost_limit',
  'price_over_cap',
  'daily_cap',
  'over_food',
  'bad_debit_id',
  'empty_batch',
  'too_many_thoughts',
  'no_pet',
  'bad_calls',
  'zero_deposit',
  'overflow',
  'no_state',
  'feed_too_small',
  'snacks_today',
  'snack_too_soon',
  'feeder_not_owner',
  'bad_stage',
  'stage_today',
  'bad_day',
  'day_marked',
  'too_many_skipped',
  'bad_hash',
  'commit_today',
  'reserve_empty',
  'reveal_too_early',
  'no_commit',
  'bad_reveal',
  'outfit_too_early',
  'outfit_owned',
  'not_for_sale',
] as const;
export type ContractCode = (typeof CONTRACT_CODES)[number];

interface RawOutcome {
  status?: unknown;
  transaction_outcome?: { block_hash?: string; outcome?: { tokens_burnt?: string } };
  receipts_outcome?: { block_hash?: string; outcome?: { tokens_burnt?: string } }[];
}

/** The NEAR a transaction burned, all its receipts together, yocto; undefined when it is zero or unknown. */
function burntOf(out: RawOutcome | null): string | undefined {
  let total = BigInt(out?.transaction_outcome?.outcome?.tokens_burnt ?? 0);
  for (const receipt of out?.receipts_outcome ?? []) total += BigInt(receipt.outcome?.tokens_burnt ?? 0);
  return total > 0n ? total.toString() : undefined;
}

function interpret(out: RawOutcome | null): TxOutcome {
  const status = out?.status as Record<string, unknown> | string | undefined;
  if (status && typeof status === 'object') {
    if ('SuccessValue' in status) {
      const b64 = status['SuccessValue'];
      const burnt = burntOf(out);
      const executionBlock = out?.receipts_outcome?.at(-1)?.block_hash ?? out?.transaction_outcome?.block_hash;
      return { status: 'ok', value: decodeSuccess(typeof b64 === 'string' ? b64 : ''), ...(burnt !== undefined ? { burnt } : {}), ...(executionBlock !== undefined ? { blockHash: executionBlock } : {}) };
    }
    if ('Failure' in status) {
      const text = JSON.stringify(status['Failure']);
      // A refused hire of a batch: `hire:<index of the thought>:<code>` (`Hire debit contract`).
      const hire = /hire:\d+:[a-z_]+/.exec(text);
      const code = hire?.[0] ?? CONTRACT_CODES.find((c) => text.includes(c)) ?? 'failed';
      const burnt = burntOf(out);
      return { status: 'failed', code, ...(burnt !== undefined ? { burnt } : {}) };
    }
  }
  return { status: 'pending' };
}

/** A method's return value as text: a JSON string unwrapped (`"7"` -> `7`), anything else as the
 * JSON text it came in. A Durable Object's answer has to be plain data. */
function decodeSuccess(b64: string): string | null {
  if (b64 === '') return null;
  const text = atob(b64);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null) return null;
    return typeof parsed === 'string' ? parsed : text;
  } catch {
    return text;
  }
}

/** The result of one transaction of the server's key. */
export type SendResult =
  | { status: 'ok'; txHash: string; value: string | null; burnt?: string }
  | { status: 'failed'; txHash: string; code: string }
  // The network did not answer in time or the answer was lost: the outcome is not known. Look at
  // the transaction by `txHash` (txStatus) or at the contract's state before signing again.
  | { status: 'unknown'; txHash: string };

export interface ServerCall {
  methodName: string;
  args: Record<string, unknown>;
  /** Prepaid gas in gas units, a decimal string. */
  gas: string;
  /** Set by a call that may write an item to the pet (`outfit_buy`, `outfit_grant`, a `streak_mark` that
   * carries a streak item): the hash of every transaction signed for it is stored before it is broadcast
   * (`pet/itemTx.ts`, design.md › The item's transaction). `buy`: the id of the `outfit_buys` row of a
   * purchase; the hash is kept only while that row is still `sending`, so a send that waited in the key's
   * queue past the cron's 5 minutes signs nothing (`noteItemSend`). */
  writes?:
    | { kind?: 'item'; tokenId: string; item: string; buy?: string }
    | { kind: 'growth'; tokenId: string; stage: 'teen' | 'adult' }
    | { kind: 'birth'; receiver: string; startedAt: number }
    | { kind: 'shared_open'; tokenId: string; jobHash: string }
    | { kind: 'shared_debit'; sessionId: string; debitId: number }
    | { kind: 'will_start'; op: string }
    | { kind: 'will_release'; op: string };
}

/** Called with the hash of a signed transaction before each broadcast. A throw means the hash could not be
 * kept, and nothing is sent. */
export type OnSigned = (txHash: string, signedBytes: Uint8Array) => Promise<void>;

export function serverAccount(env: Pick<Env, 'NEAR_RPC_URL' | 'SERVER_ACCOUNT_ID' | 'NEAR_SERVER_KEY'>): { account: Account; signer: KeyPairSigner } {
  const signer = KeyPairSigner.fromSecretKey(env.NEAR_SERVER_KEY as KeyPairString);
  return { account: new Account(env.SERVER_ACCOUNT_ID, rpcProvider(env), signer), signer };
}

function isInvalidNonce(e: unknown): boolean {
  const err = e as { type?: string; name?: string } | null;
  return err?.type === 'InvalidNonce' || err?.name === 'InvalidNonceError';
}

/** Signs and sends one call with the server's key, one transaction at a time per `account` (the
 * caller serializes). A rejected-for-nonce transaction was not included, so it is signed again
 * with a fresh nonce; any other typed refusal of the node is a definite `failed`, and any other
 * failure to hear the network leaves the outcome unknown. */
export function signAndSend(env: Pick<Env, 'CONTRACT_ID'>, keys: { account: Account; signer: KeyPairSigner }, call: ServerCall, onSigned?: OnSigned): Promise<SendResult> {
  return signAndSendActions(keys, env.CONTRACT_ID, [actions.functionCall(call.methodName, call.args, BigInt(call.gas), 0n)], onSigned);
}

/** The gas account of the project (ADR-006): the key of `NEAR_GAS_ACCOUNT_KEY`, its own nonces. */
export function gasAccount(env: Pick<Env, 'NEAR_RPC_URL' | 'GAS_ACCOUNT_ID' | 'NEAR_GAS_ACCOUNT_KEY'>): { account: Account; signer: KeyPairSigner } {
  const signer = KeyPairSigner.fromSecretKey(env.NEAR_GAS_ACCOUNT_KEY as KeyPairString);
  return { account: new Account(env.GAS_ACCOUNT_ID, rpcProvider(env), signer), signer };
}

/** A plain transfer of NEAR from the account of `keys` (the gas account's top-up of a wallet). */
export function signAndSendTransfer(keys: { account: Account; signer: KeyPairSigner }, receiverId: string, yocto: bigint, onSigned?: OnSigned): Promise<SendResult> {
  return signAndSendActions(keys, receiverId, [actions.transfer(yocto)], onSigned);
}

async function signAndSendActions(keys: { account: Account; signer: KeyPairSigner }, receiverId: string, todo: Action[], onSigned?: OnSigned): Promise<SendResult> {
  const { signer } = keys;
  const publicKey = await signer.getPublicKey();
  let lastHash = '';
  for (let attempt = 0; attempt <= SERVER_NONCE_RETRIES; attempt += 1) {
    const account = keys.account;
    let signed;
    try {
      const tx = await account.createTransaction({ receiverId, actions: todo, publicKey });
      signed = await signer.signTransaction(tx);
      // Before the broadcast, every time (a retry with a new nonce is a new transaction): a hash that
      // cannot be kept means nothing is sent.
      await onSigned?.(baseEncode(signed.txHash), signed.signedTransaction.encode());
    } catch {
      // Nothing was sent: the nonce or the block could not be read, or the hash could not be kept.
      throw new ChainUnreachable();
    }
    lastHash = baseEncode(signed.txHash);
    try {
      const out = await withTimeout(account.provider.sendTransactionUntil(signed.signedTransaction, 'EXECUTED_OPTIMISTIC'), SEND_TIMEOUT_MS);
      const result = interpret(out as RawOutcome);
      if (result?.status === 'ok') return { status: 'ok', txHash: lastHash, value: result.value, ...(result.burnt !== undefined ? { burnt: result.burnt } : {}) };
      if (result?.status === 'failed') return { status: 'failed', txHash: lastHash, code: result.code };
      return { status: 'unknown', txHash: lastHash };
    } catch (e) {
      if (isInvalidNonce(e)) {
        // That transaction was rejected, not included: a new Account re-reads the nonce.
        if (attempt === SERVER_NONCE_RETRIES) return { status: 'failed', txHash: lastHash, code: 'invalid_nonce' };
        keys.account = new Account(account.accountId, account.provider, signer);
        continue;
      }
      const refused = refusalCode(e);
      return refused === null ? { status: 'unknown', txHash: lastHash } : { status: 'failed', txHash: lastHash, code: refused };
    }
  }
  return { status: 'unknown', txHash: lastHash };
}

/** A refusal the node gave in words nearcore defines: the transaction was not included, so it is a
 * definite failure (`InvalidNonce`, `NotEnoughBalance` and the other `InvalidTxError`s). */
function refusalCode(e: unknown): string | null {
  if (e instanceof InvalidNonceError) return 'invalid_nonce';
  if (e instanceof NotEnoughBalanceError) return 'not_enough_balance';
  if (e instanceof TransactionExecutionError || e instanceof InvalidTransactionError) return 'invalid_tx';
  return null;
}

/** A `failed` of this code came from the node (`refusalCode`), not the contract: nothing was included,
 * so the contract refused nothing of what the transaction carried. */
export const isNodeRefusal = (code: string): boolean => code === 'invalid_nonce' || code === 'not_enough_balance' || code === 'invalid_tx';

/** The hash of a transaction: base58 of the SHA-256 of its borsh bytes. */
export async function txHashOf(signed: SignedTransaction): Promise<string> {
  return baseEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', encodeTransaction(signed.transaction))));
}

/** Sends a transaction the player's key signed (`Feeding transaction data`): not through `ServerKey`,
 * since the server's nonce is not involved. A typed refusal is a definite `failed`; a timeout or a
 * lost answer is `unknown`, and the caller looks the hash up before it sends the same bytes again.
 * An `InvalidNonce` may mean these very bytes already landed (a repeat of the send), so the hash is
 * looked up first; not found means another transaction took the nonce. */
export async function sendSigned(env: Pick<Env, 'NEAR_RPC_URL'>, signed: SignedTransaction): Promise<SendResult> {
  const hash = await txHashOf(signed);
  try {
    const out = await withTimeout(rpcProvider(env).sendTransactionUntil(signed, 'EXECUTED_OPTIMISTIC'), SEND_TIMEOUT_MS);
    const result = interpret(out as RawOutcome);
    if (result?.status === 'ok') return { status: 'ok', txHash: hash, value: result.value, ...(result.burnt !== undefined ? { burnt: result.burnt } : {}) };
    if (result?.status === 'failed') return { status: 'failed', txHash: hash, code: result.code };
    return { status: 'unknown', txHash: hash };
  } catch (e) {
    const refused = refusalCode(e);
    if (refused === null) return { status: 'unknown', txHash: hash };
    if (!(e instanceof InvalidNonceError)) return { status: 'failed', txHash: hash, code: refused };
    let known: TxOutcome;
    try {
      known = await txStatus(env, hash, signed.transaction.signerId);
    } catch {
      return { status: 'unknown', txHash: hash };
    }
    if (known?.status === 'ok') return { status: 'ok', txHash: hash, value: known.value, ...(known.burnt !== undefined ? { burnt: known.burnt } : {}) };
    if (known?.status === 'failed') return { status: 'failed', txHash: hash, code: known.code };
    if (known?.status === 'pending') return { status: 'unknown', txHash: hash };
    return { status: 'failed', txHash: hash, code: refused };
  }
}
