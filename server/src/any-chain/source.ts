import { type Origin } from './quote';
import { ChainUnreachable } from '../chain';

const SOLANA = 'https://api.mainnet-beta.solana.com';
const BASE = 'https://mainnet.base.org';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BASE_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOL_HASH = /^[1-9A-HJ-NP-Za-km-z]{70,100}$/;

export interface SourceTransfer { hash: string; sender: string; recipient: string; amount: string }
export interface SourceObservation extends SourceTransfer { asset: 'usdc' | 'other'; at: number | null; index: number }

interface SolanaBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
interface SolanaInstruction { program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string;
  mint?: string; amount?: string; tokenAmount?: { amount?: string } } } }
interface SolanaTx { blockTime?: number; meta?: { err: unknown; preTokenBalances?: SolanaBalance[];
  postTokenBalances?: SolanaBalance[]; innerInstructions?: { instructions?: SolanaInstruction[] }[] };
  transaction?: { message?: { accountKeys?: ({ pubkey: string } | string)[]; instructions?: SolanaInstruction[] } } }

function tokenTransferIndex(tx: SolanaTx, from: SolanaBalance, to: SolanaBalance, amount: string): number {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const key = (index: number) => { const value = keys[index]; return typeof value === 'string' ? value : value?.pubkey; };
  const source = key(from.accountIndex);
  const destination = key(to.accountIndex);
  if (!source || !destination) return -1;
  const instructions = [...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((item) => item.instructions ?? [])];
  return instructions.findIndex((instruction) => {
    const parsed = instruction.parsed;
    const info = parsed?.info;
    const units = info?.tokenAmount?.amount ?? info?.amount;
    return instruction.program === 'spl-token' && (parsed?.type === 'transfer' || parsed?.type === 'transferChecked') &&
      info?.source === source && info.destination === destination &&
      (info.mint === undefined || info.mint === to.mint) && units === amount;
  });
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new ChainUnreachable();
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (body.error || body.result == null) throw new ChainUnreachable();
    return body.result;
  } catch { throw new ChainUnreachable(); }
}

/** A finalized USDC transfer into the quoted deposit address; the debited token owner is the return recipient. */
export async function verifiedSource(chain: Origin, hash: string, deposit: string, minimum: string): Promise<SourceTransfer | null> {
  if (chain === 'base') {
    if (!BASE_HASH.test(hash) || !/^0x[0-9a-fA-F]{40}$/.test(deposit)) return null;
    const receipt = await rpc(BASE, 'eth_getTransactionReceipt', [hash]) as {
      status?: string; blockNumber?: string; logs?: { address: string; topics: string[]; data: string }[] };
    if (receipt.status !== '0x1' || !receipt.blockNumber) return null;
    const finalized = await rpc(BASE, 'eth_getBlockByNumber', ['finalized', false]) as { number?: string };
    if (!finalized.number || BigInt(receipt.blockNumber) > BigInt(finalized.number)) return null;
    for (const log of receipt.logs ?? []) {
      if (log.address.toLowerCase() !== USDC_BASE.toLowerCase() || log.topics?.[0]?.toLowerCase() !== TRANSFER ||
        log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
      const sender = `0x${log.topics[1]!.slice(-40)}`;
      const recipient = `0x${log.topics[2]!.slice(-40)}`;
      const amount = BigInt(log.data).toString();
      if (recipient.toLowerCase() === deposit.toLowerCase() && BigInt(amount) >= BigInt(minimum))
        return { hash, sender, recipient, amount };
    }
    return null;
  }
  if (!SOL_HASH.test(hash)) return null;
  const tx = await rpc(SOLANA, 'getTransaction', [hash,
    { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as SolanaTx;
  if (!tx.meta || tx.meta.err !== null) return null;
  const before = tx.meta.preTokenBalances ?? [];
  const after = tx.meta.postTokenBalances ?? [];
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const credited = after.find((entry) => entry.mint === USDC_SOLANA && entry.owner === deposit &&
    BigInt(entry.uiTokenAmount.amount) - BigInt(before.find((old) => old.accountIndex === entry.accountIndex)?.uiTokenAmount.amount ?? '0') >= BigInt(minimum));
  if (!credited) return null;
  const amount = (BigInt(credited.uiTokenAmount.amount) -
    BigInt(before.find((old) => old.accountIndex === credited.accountIndex)?.uiTokenAmount.amount ?? '0')).toString();
  const debited = before.find((entry) => entry.mint === USDC_SOLANA && entry.owner &&
    BigInt(entry.uiTokenAmount.amount) - BigInt(after.find((post) => post.accountIndex === entry.accountIndex)?.uiTokenAmount.amount ?? '0') >= BigInt(minimum));
  if (!debited?.owner) return null;
  if (tokenTransferIndex(tx, debited, credited, amount) < 0) return null;
  return { hash, sender: debited.owner, recipient: credited.owner!, amount };
}

/** A quote-route return uses the provider's matched status, amount and destination hash. */
export function confirmedReturn(hash: string, minimum: string, providerAmount: string | undefined): string | null {
  if (!/^[A-Za-z0-9:_-]{16,128}$/.test(hash) || !/^\d{1,78}$/.test(providerAmount ?? '') ||
    BigInt(providerAmount!) < BigInt(minimum)) return null;
  return providerAmount!;
}

/** Finalized token movement into the public destination; it can be the wrong asset or below the quote. */
export async function observedSource(chain: Origin, hash: string, deposit: string, transferIndex?: number): Promise<SourceObservation | null> {
  if (chain === 'base') {
    if (!BASE_HASH.test(hash) || !/^0x[0-9a-fA-F]{40}$/.test(deposit)) return null;
    const receipt = await rpc(BASE, 'eth_getTransactionReceipt', [hash]) as {
      status?: string; blockNumber?: string; logs?: { address: string; topics: string[]; data: string; logIndex?: string }[] };
    if (receipt.status !== '0x1' || !receipt.blockNumber) return null;
    const finalized = await rpc(BASE, 'eth_getBlockByNumber', ['finalized', false]) as { number?: string };
    if (!finalized.number || BigInt(receipt.blockNumber) > BigInt(finalized.number)) return null;
    const block = await rpc(BASE, 'eth_getBlockByNumber', [receipt.blockNumber, false]) as { timestamp?: string };
    for (const [position, log] of (receipt.logs ?? []).entries()) {
      if (log.topics?.[0]?.toLowerCase() !== TRANSFER || log.topics.length !== 3 ||
        !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
      const recipient = `0x${log.topics[2]!.slice(-40)}`;
      const index = log.logIndex ? Number(BigInt(log.logIndex)) : position;
      if (recipient.toLowerCase() !== deposit.toLowerCase() || (transferIndex !== undefined && transferIndex !== index)) continue;
      return { hash, sender: `0x${log.topics[1]!.slice(-40)}`, recipient,
        amount: BigInt(log.data).toString(), asset: log.address.toLowerCase() === USDC_BASE.toLowerCase() ? 'usdc' : 'other',
        at: block.timestamp ? Number(BigInt(block.timestamp)) * 1000 : null,
        index };
    }
    return null;
  }
  if (!SOL_HASH.test(hash)) return null;
  const tx = await rpc(SOLANA, 'getTransaction', [hash,
    { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as SolanaTx;
  if (!tx.meta || tx.meta.err !== null) return null;
  const before = tx.meta.preTokenBalances ?? [];
  const after = tx.meta.postTokenBalances ?? [];
  const matches = after.filter((entry) => entry.owner === deposit &&
    BigInt(entry.uiTokenAmount.amount) > BigInt(before.find((old) => old.accountIndex === entry.accountIndex)?.uiTokenAmount.amount ?? '0'));
  const received = matches.find((entry) => entry.mint === USDC_SOLANA) ?? matches[0];
  if (!received) return null;
  const debited = before.find((entry) => entry.mint === received.mint && entry.owner &&
    BigInt(entry.uiTokenAmount.amount) > BigInt(after.find((post) => post.accountIndex === entry.accountIndex)?.uiTokenAmount.amount ?? '0'));
  if (!debited?.owner) return null;
  const amount = (BigInt(received.uiTokenAmount.amount) -
    BigInt(before.find((old) => old.accountIndex === received.accountIndex)?.uiTokenAmount.amount ?? '0')).toString();
  const index = tokenTransferIndex(tx, debited, received, amount);
  if (index < 0 || (transferIndex !== undefined && transferIndex !== index)) return null;
  return { hash, sender: debited.owner, recipient: deposit,
    amount,
    asset: received.mint === USDC_SOLANA ? 'usdc' : 'other', at: tx.blockTime ? tx.blockTime * 1000 : null, index };
}
