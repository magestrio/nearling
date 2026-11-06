import { config } from '../config';
import { nearRpc } from '../seams/rpc';

export interface ChainSharedJob {
  hash: string;
  state: 'funding' | 'running' | 'transferred' | 'settled';
  linked_near: string;
  linked_snack: string;
}

interface ChainPet { owner_id: string; shared_job: ChainSharedJob | null }
export interface CloseApproval { public_key: string; signature: string }

export async function sharedJobOf(tokenId: string): Promise<ChainPet | null> {
  return nearRpc.viewFunction<ChainPet | null>(config.contractId, 'pet_view', { token_id: tokenId });
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

// spec: add-pet-errands › Friend-funded errand flow › owner confirms closing an unsettled job
export async function closeApproval(tokenId: string, account: string, sign: (hash: string) => Promise<Uint8Array>, expectedHash?: string): Promise<CloseApproval> {
  const pet = await sharedJobOf(tokenId);
  const hash = pet?.shared_job?.hash;
  if (pet?.owner_id !== account || !hash || !/^[0-9a-f]{64}$/.test(hash) || (expectedHash && expectedHash !== hash)) throw new Error('stale shared job');
  const message = `nearling:shared-job-close:v1:${config.contractId}:${tokenId}:${hash}:close`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)));
  return { public_key: account, signature: hex(await sign(hex(digest))) };
}

export function linkedFood(job: ChainSharedJob): bigint {
  return BigInt(job.linked_near) + BigInt(job.linked_snack);
}

export function nearAmount(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const fraction = (yocto % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
}
