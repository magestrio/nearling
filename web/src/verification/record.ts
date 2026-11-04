import type { NearRpc } from '../seams/rpc';
import { OUTFITS } from '../wardrobe/catalogue';
import { sha256Hex } from './check';
import { outcomeFor } from './checkMachine';

/** Only public chain data supplies the record; the Worker supplies transaction pointers and the worn label. */
export interface ChainPetRecord {
  owner_id: string; name: string; character: string; born_at: number;
  stage: 'Baby' | 'Teen' | 'Adult'; traits: string[]; outfits: number[];
}
export interface RecordIndex {
  tokenId: string;
  worn: string | null;
  transactions: Array<{ kind: string; ref: string; txHash: string; at: number }>;
}
export interface SourceMetadata { version: string; link: string }
export interface RecordEvent { event: 'pet_born' | 'grow' | 'outfit'; data: Record<string, unknown> }
export interface RecordEvidence {
  kind: 'found' | 'too-old' | 'unavailable'; event?: RecordEvent;
}
export interface RecordItem {
  kind: 'character' | 'growth' | 'outfit' | 'source';
  text: string; proof?: string; txHash?: string; txHref?: string;
  link: 'ready' | 'not-ready' | 'too-old' | 'unavailable';
  priceNear?: string;
}
export interface PetRecordModel {
  name: string; characterHash: string; character: 'checked' | 'mismatch' | 'pending' | 'unavailable';
  items: RecordItem[]; source: SourceMetadata;
}

export function explorerTx(hash: string, network: string): string {
  return `https://${network === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${encodeURIComponent(hash)}`;
}

export function eventFromOutcome(outcome: unknown, tokenId: string, contractId: string): RecordEvent | null {
  if (typeof outcome !== 'object' || outcome === null) return null;
  const tx = outcome as { status?: unknown; transaction?: { receiver_id?: string }; receipts_outcome?: Array<{ outcome?: { logs?: string[] } }> };
  if (typeof tx.status !== 'object' || tx.status === null || !('SuccessValue' in tx.status)
    || tx.transaction?.receiver_id !== contractId) return null;
  for (const log of (tx.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? [])) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    let raw: unknown;
    try { raw = JSON.parse(log.slice(11)); } catch { continue; }
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as { standard?: unknown; version?: unknown; event?: unknown; data?: unknown };
    if (event.standard !== 'nearling' || event.version !== '1.0.0'
      || !['pet_born', 'grow', 'outfit'].includes(String(event.event))) continue;
    const data = Array.isArray(event.data) ? event.data[0] : event.data;
    if (typeof data !== 'object' || data === null || (data as { token_id?: unknown }).token_id !== tokenId) continue;
    return { event: event.event as RecordEvent['event'], data: data as Record<string, unknown> };
  }
  return null;
}

const txFor = (index: RecordIndex, kind: string, ref: string) =>
  index.transactions.find((tx) => tx.kind === kind && tx.ref.toLowerCase() === ref.toLowerCase());
const itemLink = (kind: RecordItem['kind'], text: string, tx: ReturnType<typeof txFor>,
  evidence: RecordEvidence | undefined, network: string, extra: Partial<RecordItem> = {}): RecordItem => ({
  kind, text, ...extra,
  link: !tx ? 'not-ready' : evidence?.kind === 'found' ? 'ready' : evidence?.kind ?? 'unavailable',
  ...(tx ? { txHash: tx.txHash, txHref: explorerTx(tx.txHash, network) } : {}),
});

function near(yocto: string): string | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(yocto)) return undefined;
  const n = BigInt(yocto);
  return `${n / 10n ** 24n}${n % 10n ** 24n === 0n ? '' : `.${(n % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '')}`} NEAR`;
}

/** Build only what pet_view says exists. A missing pointer never becomes a fabricated chain match. */
export function buildRecord(pet: ChainPetRecord, index: RecordIndex, hash: string,
  evidence: ReadonlyMap<string, RecordEvidence>, source: SourceMetadata, contractId: string,
  network: string): PetRecordModel {
  const items: RecordItem[] = [];
  const birth = txFor(index, 'birth', 'birth');
  const birthEvidence = birth ? evidence.get(birth.txHash) : undefined;
  const birthEvent = birthEvidence?.kind === 'found' && birthEvidence.event?.event === 'pet_born'
    ? birthEvidence.event.data : null;
  const character = !birth ? 'pending' : birthEvidence?.kind !== 'found' ? 'unavailable'
    : typeof birthEvent?.character_sha256 !== 'string' ? 'unavailable'
      : birthEvent.character_sha256.toLowerCase() === hash.toLowerCase() ? 'checked' : 'mismatch';
  const date = new Date(Math.floor(pet.born_at / 1_000_000));
  const dateWord = Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(date);
  items.push(itemLink('character', pet.character, birth, birthEvidence, network, {
    ...(character === 'checked' ? { proof: `Sealed at hatch. This character matches the fingerprint ${pet.name} got on NEAR on ${dateWord}.` }
      : character === 'mismatch' ? { proof: `This character doesn't match the one sealed when ${pet.name} hatched.` } : {}),
  }));

  const stages = pet.stage === 'Baby' ? [] : pet.stage === 'Teen' ? ['Teen'] : ['Teen', 'Adult'];
  stages.forEach((stage, i) => {
    const trait = pet.traits[i];
    if (trait === undefined) return;
    const repeated = i > 0 && trait === pet.traits[i - 1];
    const verb = i === 0 ? 'Became a teen' : 'Grew up';
    const word = trait.replaceAll('_', '-');
    const tx = txFor(index, 'growth', stage);
    const fact = tx ? evidence.get(tx.txHash) : undefined;
    const event = fact?.event;
    const valid = event?.event === 'grow' && event.data.stage === stage && event.data.trait === trait;
    items.push(itemLink('growth', `${verb} — ${repeated ? 'even more ' : ''}${word}`, tx,
      fact?.kind === 'found' && !valid ? { kind: 'unavailable' } : fact, network));
  });

  const outfitIds = [...pet.outfits].sort((left, right) =>
    Number(OUTFITS[right]?.slug === index.worn) - Number(OUTFITS[left]?.slug === index.worn));
  for (const id of outfitIds) {
    const outfit = OUTFITS[id];
    if (!outfit) continue;
    const tx = txFor(index, 'item', outfit.slug);
    const fact = tx ? evidence.get(tx.txHash) : undefined;
    const event = fact?.event;
    const valid = event?.event === 'outfit' && event.data.item === id;
    const priceNear = valid && typeof event.data.price === 'string' ? near(event.data.price) : undefined;
    items.push(itemLink('outfit', outfit.name, tx,
      fact?.kind === 'found' && !valid ? { kind: 'unavailable' } : fact, network, {
        ...(index.worn === outfit.slug ? { proof: 'Wearing now · saved by the game, not on NEAR' } : {}),
        ...(outfit.kind === 'bought' && priceNear ? { priceNear } : {}),
      }));
  }
  items.push({ kind: 'source', text: contractId, proof: 'We can update the code with our key — every update is public.', link: 'ready' });
  return { name: pet.name, characterHash: hash, character, items, source };
}

export async function characterHash(character: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(character));
}

export async function loadRecord(rpc: NearRpc, tokenId: string, index: RecordIndex, contractId: string,
  signerId: string, network: string): Promise<PetRecordModel | null> {
  const [pet, source] = await Promise.all([
    rpc.viewFunction<ChainPetRecord | null>(contractId, 'pet_view', { token_id: tokenId }),
    rpc.viewFunction<SourceMetadata>(contractId, 'contract_source_metadata', {}),
  ]);
  if (pet === null) return null;
  const evidence = new Map<string, RecordEvidence>();
  await Promise.all(index.transactions.map(async (tx) => {
    const result = await outcomeFor(rpc, tx.txHash, signerId, tx.at);
    evidence.set(tx.txHash, result.kind === 'found'
      ? { kind: 'found', event: eventFromOutcome(result.outcome, tokenId, contractId) ?? undefined }
      : { kind: result.kind });
  }));
  return buildRecord(pet, index, await characterHash(pet.character), evidence, source, contractId, network);
}
