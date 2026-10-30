// The Worker's reads of the NEAR contract and the transactions of the server's key.
//
// Reads (`pet_view`, `hatch_view`, `nft_supply_for_owner`, balances, a transaction's status) are
// plain JSON-RPC through near-api-js; a failure of the network is `ChainUnreachable` (the routes
// answer 503, nothing is served or accepted). The transactions of the server's key go through the
// `ServerKey` Durable Object, one at a time (`src/do/serverKey.ts`), and use `signAndSend` below.
import { Account, JsonRpcProvider, KeyPairSigner, actions, baseEncode, type KeyPairString } from 'near-api-js';

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
  debit_day: number;
  debited_today: string;
  last_debit_id: number;
  /** `Stage` of the contract, as near-sdk writes it: `"Baby"`. The client's word comes from `stageOf`. */
  stage: string;
  stage_day: number;
  streak: number;
  freezes: number;
}

export type Stage = 'baby' | 'teen' | 'adult';

/** The stage in the word every answer to the client uses (the contract says `Baby`). */
export function stageOf(pet: Pick<PetRecord, 'stage'>): Stage {
  return pet.stage.toLowerCase() as Stage;
}

export interface HatchRecord {
  token_id: string | null;
  day: number;
  born_today: number;
  pool: string;
}

/** Prepaid gas of `pet_mint`, Tgas. The mint's gas grows with the token tree: 8.56 Tgas burnt at most
 * over 260 births (`contract/tests/pet_mint.rs`, which reads this line and births them with it).
 * Unused gas is refunded. */
export const PET_MINT_TGAS = 15n;

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

/** What the network says about a transaction we sent. `null`: the network has not seen it (yet). */
export type TxOutcome = { status: 'ok'; value: string | null; burnt?: string } | { status: 'failed'; code: string } | { status: 'pending' } | null;

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
  'daily_births',
  'name_too_long',
  'character_too_long',
  'pool_empty',
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
] as const;
export type ContractCode = (typeof CONTRACT_CODES)[number];

interface RawOutcome {
  status?: unknown;
  transaction_outcome?: { outcome?: { tokens_burnt?: string } };
  receipts_outcome?: { outcome?: { tokens_burnt?: string } }[];
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
      return { status: 'ok', value: decodeSuccess(typeof b64 === 'string' ? b64 : ''), ...(burnt !== undefined ? { burnt } : {}) };
    }
    if ('Failure' in status) {
      const text = JSON.stringify(status['Failure']);
      const code = CONTRACT_CODES.find((c) => text.includes(c)) ?? 'failed';
      return { status: 'failed', code };
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
}

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
 * with a fresh nonce; any other failure to hear the network leaves the outcome unknown. */
export async function signAndSend(
  env: Pick<Env, 'CONTRACT_ID'>,
  keys: { account: Account; signer: KeyPairSigner },
  call: ServerCall,
): Promise<SendResult> {
  const { signer } = keys;
  const publicKey = await signer.getPublicKey();
  let lastHash = '';
  for (let attempt = 0; attempt <= SERVER_NONCE_RETRIES; attempt += 1) {
    const account = keys.account;
    let signed;
    try {
      const tx = await account.createTransaction({
        receiverId: env.CONTRACT_ID,
        actions: [actions.functionCall(call.methodName, call.args, BigInt(call.gas), 0n)],
        publicKey,
      });
      signed = await signer.signTransaction(tx);
    } catch {
      // Nothing was sent: the nonce or the block could not be read.
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
        keys.account = new Account(account.accountId, account.provider, signer);
        continue;
      }
      return { status: 'unknown', txHash: lastHash };
    }
  }
  return { status: 'unknown', txHash: lastHash };
}
