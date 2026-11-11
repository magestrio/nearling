import { keccak_256 } from '@noble/hashes/sha3.js';
import { baseDecode, baseEncode } from 'near-api-js';
import { ChainUnreachable, rpcProvider } from '../chain';
import { type Origin, QuoteUnavailable } from './quote';

interface SignerView { signer_id: string | null; base_domain_id: number; solana_domain_id: number; path_format: string }
interface AddressRow { public_key: string; address: string; signer_id: string; domain_id: number }
export interface PetAddress { chain: Origin; address: string; publicKey: string; path: string }

async function read<T>(env: Env, account: string, method: string, args: Record<string, unknown>): Promise<T> {
  try { return await rpcProvider(env).callFunction({ contractId: account, method, args }) as T; }
  catch { throw new ChainUnreachable(); }
}

export async function currentOwner(env: Env, tokenId: string): Promise<string | null> {
  const token = await read<{ owner_id?: unknown } | null>(env, env.CONTRACT_ID, 'nft_token', { token_id: tokenId });
  return typeof token?.owner_id === 'string' ? token.owner_id : null;
}

export function encodePetAddress(chain: Origin, key: string): string {
  const [kind, encoded, extra] = key.split(':');
  if (extra || kind !== (chain === 'base' ? 'secp256k1' : 'ed25519') || !encoded) throw new QuoteUnavailable('signer_unavailable');
  let bytes: Uint8Array;
  try { bytes = baseDecode(encoded); } catch { throw new QuoteUnavailable('signer_unavailable'); }
  if (chain === 'solana') {
    if (bytes.length !== 32) throw new QuoteUnavailable('signer_unavailable');
    return baseEncode(bytes);
  }
  // The signer view returns the uncompressed secp256k1 X and Y (64 bytes).
  if (bytes.length !== 64) throw new QuoteUnavailable('signer_unavailable');
  return `0x${Array.from(keccak_256(bytes).slice(-20), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Derive both public addresses from the contract's pinned signer and preserve the first offered pair. */
export async function petAddresses(env: Env, tokenId: string): Promise<PetAddress[] | null> {
  if (await currentOwner(env, tokenId) === null) return null;
  const signer = await read<SignerView>(env, env.CONTRACT_ID, 'sweep_signer_view', {});
  if (!signer?.signer_id || signer.path_format !== '<chain>:<token_id>' ||
    signer.base_domain_id !== 0 || signer.solana_domain_id !== 1) throw new QuoteUnavailable('signer_unavailable');
  const addresses: PetAddress[] = [];
  for (const chain of ['base', 'solana'] as const) {
    const domainId = chain === 'base' ? signer.base_domain_id : signer.solana_domain_id;
    const path = `${chain}:${tokenId}`;
    const key = await read<unknown>(env, signer.signer_id, 'derived_public_key',
      { path, predecessor: env.CONTRACT_ID, domain_id: domainId });
    if (typeof key !== 'string') throw new QuoteUnavailable('signer_unavailable');
    addresses.push({ chain, address: encodePetAddress(chain, key), publicKey: key, path });
  }
  const prior = await env.DB.prepare('SELECT chain, public_key, address, signer_id, domain_id FROM any_chain_addresses WHERE token_id = ?')
    .bind(tokenId).all<AddressRow & { chain: Origin }>();
  for (const address of addresses) {
    const old = prior.results.find((row) => row.chain === address.chain);
    if (old && (old.public_key !== address.publicKey || old.address !== address.address || old.signer_id !== signer.signer_id ||
      old.domain_id !== (address.chain === 'base' ? signer.base_domain_id : signer.solana_domain_id)))
      throw new QuoteUnavailable('signer_unavailable');
  }
  try {
    await env.DB.batch(addresses.map((address) => env.DB.prepare(`INSERT OR IGNORE INTO any_chain_addresses
      (token_id, chain, signer_id, domain_id, path, public_key, address, first_offered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(tokenId, address.chain, signer.signer_id,
        address.chain === 'base' ? signer.base_domain_id : signer.solana_domain_id,
        address.path, address.publicKey, address.address, Date.now())));
  } catch { throw new QuoteUnavailable('signer_unavailable'); }
  // A competing first offer can win between the read and INSERT OR IGNORE.
  const pinned = await env.DB.prepare('SELECT chain, public_key, address, signer_id, domain_id FROM any_chain_addresses WHERE token_id = ?')
    .bind(tokenId).all<AddressRow & { chain: Origin }>();
  if (pinned.results.length !== 2 || addresses.some((address) => {
    const row = pinned.results.find((item) => item.chain === address.chain);
    return !row || row.public_key !== address.publicKey || row.address !== address.address || row.signer_id !== signer.signer_id ||
      row.domain_id !== (address.chain === 'base' ? signer.base_domain_id : signer.solana_domain_id);
  })) throw new QuoteUnavailable('signer_unavailable');
  return addresses;
}
