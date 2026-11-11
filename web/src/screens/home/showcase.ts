import type { MeadowVisit, MeadowNumber } from '../../ds/Meadow';
import type { ShowcaseCopy } from '../../seams/worker-types';

const places = [
  { x: 0.04, depth: 0.95 }, { x: 0.97, depth: 0.88, flip: true },
  { x: 0.5, depth: 0.5 }, { x: 0.1, depth: 0.2 },
  { x: 0.92, depth: 0.12, flip: true }, { x: 0.72, depth: 0.3, wide: true },
  { x: 0.3, depth: 0.35, flip: true, wide: true }, { x: 0.4, depth: 0.05, wide: true },
  { x: 0.68, depth: 0.68, flip: true, wide: true }, { x: 0.27, depth: 0.8, wide: true },
] as const;

export function meadowPets(copy: ShowcaseCopy): MeadowVisit[] {
  return copy.pets.slice(0, 10).map((pet, i) => ({
    ...places[i]!, seed: Number(pet.tokenId), stage: pet.stage, state: pet.fullness,
    outfit: pet.worn ?? undefined, view: 'three-quarter', href: `/pet/${encodeURIComponent(pet.tokenId)}`,
    name: pet.name, tag: `${pet.name} · ${pet.fullness === 'asleep' ? 'asleep — out of food' : pet.fullness}`,
  }));
}

export function meadowNumbers(copy: ShowcaseCopy): MeadowNumber[] | undefined {
  if (!copy.numbers || copy.pets.length === 0) return undefined;
  const { pets_hatched: pets, thoughts_paid: thoughts, spent, hires_completed: hires, friend_snacks: snacks, counted_since: sinceNs } = copy.numbers;
  const count = (n: number) => new Intl.NumberFormat('en-US').format(n);
  const near = Number(spent) / 1e24;
  const amount = near < 1
    ? new Intl.NumberFormat('en-US', { minimumSignificantDigits: 2, maximumSignificantDigits: 2 }).format(near)
    : new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(near);
  const since = sinceNs > 0 ? `since ${new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(sinceNs / 1_000_000))}` : undefined;
  return [
    { value: count(pets), label: pets === 1 ? 'pet hatched' : 'pets hatched' },
    { value: count(thoughts), label: thoughts === 1 ? 'thought paid for' : 'thoughts paid for' },
    Number.isFinite(copy.nearUsdPrice) && (copy.nearUsdPrice ?? 0) > 0
      ? { value: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(near * copy.nearUsdPrice!), label: 'spent on thinking', detail: `${amount} NEAR` }
      : { value: `${amount} NEAR`, label: 'spent on thinking' },
    { value: count(hires), label: 'hires', since },
    { value: count(snacks), label: 'friend snacks', since },
  ];
}
