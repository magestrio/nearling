import { baseDecode, baseEncode } from 'near-api-js';
import { type Origin, QuoteUnavailable } from './quote';
import { associatedTokenAccount, baseSweepPayload, bytesHex, solanaSweepMessage, SOLANA_USDC, BASE_USDC } from './sweepPayload';

const URLS = { base: 'https://mainnet.base.org', solana: 'https://api.mainnet-beta.solana.com' } as const;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export async function sourceRpc<T>(chain: Origin, method: string, params: unknown[]): Promise<T> {
  try {
    const response = await fetch(URLS[chain], { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('rpc_http');
    const answer = await response.json() as { result?: T; error?: unknown };
    if (answer.error || answer.result === undefined) throw new Error('rpc_error');
    return answer.result;
  } catch { throw new QuoteUnavailable('source_unavailable'); }
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new QuoteUnavailable('source_unavailable');
  return BigInt(value);
}

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function key(address: string): Uint8Array {
  try { const bytes = baseDecode(address); if (bytes.length === 32) return bytes; } catch { /* invalid key */ }
  throw new QuoteUnavailable('source_unavailable');
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, item) => n + item.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/** Live source evidence needed to bind the owner envelope to one specific transfer. */
export type SweepSource = {
  payloadHex: string; destination: string; nativeGas: bigint; nativeRent: bigint;
  nativeFunding: bigint; sourceMeta: Record<string, string>;
  nativePrice: number; accountCreationMessage?: string; accountCreationBlockhash?: string;
};

export async function baseSource(wallet: string, recipient: string, amount: bigint, nativePrice: number): Promise<SweepSource> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || !/^0x[0-9a-fA-F]{40}$/.test(recipient))
    throw new QuoteUnavailable('provider_unavailable');
  const data = `0xa9059cbb${'0'.repeat(24)}${recipient.slice(2).toLowerCase()}${amount.toString(16).padStart(64, '0')}`;
  const [nonceRaw, gasRaw, priceRaw] = await Promise.all([
    sourceRpc<string>('base', 'eth_getTransactionCount', [wallet, 'pending']),
    sourceRpc<string>('base', 'eth_estimateGas', [{ from: wallet, to: BASE_USDC, data, gasPrice: '0x0' }]),
    sourceRpc<string>('base', 'eth_gasPrice', []),
  ]);
  const nonce = quantity(nonceRaw);
  const estimate = quantity(gasRaw);
  const gasPrice = quantity(priceRaw);
  if (estimate === 0n || gasPrice === 0n) throw new QuoteUnavailable('source_unavailable');
  const gasLimit = estimate * 12n / 10n;
  const maxFee = gasPrice * 12n / 10n;
  const priority = gasPrice / 10n || 1n;
  const nativeFunding = gasLimit * maxFee;
  const fundingFee = 21_000n * maxFee;
  return { payloadHex: bytesHex(baseSweepPayload(recipient, amount, nonce, priority, maxFee, gasLimit)),
    destination: recipient.toLowerCase(), nativeGas: nativeFunding + fundingFee, nativeRent: 0n,
    nativeFunding, sourceMeta: { nonce: nonce.toString(), priority: priority.toString(),
      maxFee: maxFee.toString(), gasLimit: gasLimit.toString() }, nativePrice };
}

export function solanaCreateAtaMessage(gasWallet: string, recipient: string, destination: string, blockhash: string): Uint8Array {
  const keys = [gasWallet, destination, recipient, SOLANA_USDC, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM].map(key);
  // One signer and five read-only unsigned accounts; CreateIdempotent has instruction data [1].
  return concat(Uint8Array.of(1, 0, 5, 7), ...keys, key(blockhash),
    Uint8Array.of(1, 6, 6, 0, 1, 2, 3, 4, 5, 1, 1));
}

export async function solanaSource(wallet: string, recipient: string, amount: bigint,
  nativePrice: number, gasWallet: string): Promise<SweepSource> {
  let destination: string;
  try { destination = associatedTokenAccount(recipient); } catch { throw new QuoteUnavailable('provider_unavailable'); }
  const [block, account] = await Promise.all([
    sourceRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('solana', 'getLatestBlockhash', [{ commitment: 'confirmed' }]),
    sourceRpc<{ value: { owner: string; space: number } | null }>('solana', 'getAccountInfo', [destination, { encoding: 'base64', commitment: 'confirmed' }]),
  ]);
  const blockhash = block.value?.blockhash;
  if (!blockhash) throw new QuoteUnavailable('source_unavailable');
  if (account.value && (account.value.owner !== TOKEN_PROGRAM || account.value.space !== 165))
    throw new QuoteUnavailable('provider_unavailable');
  const payload = solanaSweepMessage(wallet, destination, blockhash, amount);
  const transferFee = await sourceRpc<{ value: number | null }>('solana', 'getFeeForMessage',
    [base64(payload), { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(transferFee.value) || !transferFee.value || transferFee.value <= 0)
    throw new QuoteUnavailable('source_unavailable');
  let nativeRent = 0n;
  let accountCreationMessage: string | undefined;
  if (account.value === null) {
    const creation = solanaCreateAtaMessage(gasWallet, recipient, destination, blockhash);
    const [rent, fee] = await Promise.all([
      sourceRpc<number>('solana', 'getMinimumBalanceForRentExemption', [165, { commitment: 'confirmed' }]),
      sourceRpc<{ value: number | null }>('solana', 'getFeeForMessage',
        [base64(creation), { commitment: 'confirmed' }]),
    ]);
    if (!Number.isSafeInteger(rent) || rent <= 0 || !Number.isSafeInteger(fee.value) || !fee.value || fee.value <= 0)
      throw new QuoteUnavailable('source_unavailable');
    nativeRent = BigInt(rent) + BigInt(fee.value);
    accountCreationMessage = base64(creation);
  }
  const funding = solanaFundMessage(gasWallet, wallet, BigInt(transferFee.value), blockhash);
  const fundingFee = await sourceRpc<{ value: number | null }>('solana', 'getFeeForMessage',
    [base64(funding), { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(fundingFee.value) || !fundingFee.value || fundingFee.value <= 0)
    throw new QuoteUnavailable('source_unavailable');
  return { payloadHex: bytesHex(payload), destination,
    nativeGas: BigInt(transferFee.value) + BigInt(fundingFee.value), nativeRent,
    nativeFunding: BigInt(transferFee.value), sourceMeta: { blockhash }, nativePrice,
    ...(accountCreationMessage ? { accountCreationMessage, accountCreationBlockhash: blockhash } : {}) };
}

export function solanaFundMessage(gasWallet: string, recipient: string, lamports: bigint, blockhash: string): Uint8Array {
  return concat(Uint8Array.of(1, 0, 1, 3), key(gasWallet), key(recipient), key(SYSTEM_PROGRAM),
    key(blockhash), Uint8Array.of(1, 2, 2, 0, 1, 12, 2, 0, 0, 0), u64(lamports));
}

export function base64Transaction(message: Uint8Array, signature: Uint8Array): string {
  if (signature.length !== 64) throw new QuoteUnavailable('source_unavailable');
  return base64(concat(Uint8Array.of(1), signature, message));
}

export function solanaSignature(signature: Uint8Array): string { return baseEncode(signature); }

/** Source-chain truth for the USDC still controlled by this pet path. */
export async function sourceBalance(chain: Origin, wallet: string): Promise<bigint> {
  if (chain === 'base') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new QuoteUnavailable('source_unavailable');
    const data = `0x70a08231${wallet.slice(2).padStart(64, '0')}`;
    return quantity(await sourceRpc<string>('base', 'eth_call', [{ to: BASE_USDC, data }, 'latest']));
  }
  const address = associatedTokenAccount(wallet);
  const account = await sourceRpc<{ value: { owner: string } | null }>('solana', 'getAccountInfo',
    [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (account.value === null) return 0n;
  if (account.value.owner !== TOKEN_PROGRAM) throw new QuoteUnavailable('source_unavailable');
  const balance = await sourceRpc<{ value: { amount: string } }>('solana', 'getTokenAccountBalance',
    [address, { commitment: 'confirmed' }]);
  if (!/^\d+$/.test(balance.value?.amount ?? '')) throw new QuoteUnavailable('source_unavailable');
  return BigInt(balance.value.amount);
}
