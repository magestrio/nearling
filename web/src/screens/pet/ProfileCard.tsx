import { Button, Cluster, Note, PetCard, Seal, Segmented, Stack, Text, TextLink, type TraitName } from '../../ds';
import { debatePath, experiencePath, relationshipsPath, workRecordPath } from '../../route';
import { PetFigure } from '../../pet/PetFigure';
import type { HireMode, PetView } from '../../seams/worker';
import { nameOf, OUTFITS, wearProps } from '../../wardrobe/catalogue';
import { wishProgress } from '../../will/WishSheet';
import type { SealState } from '../../verification/seal';
import { sealLine } from './sealLine';

const TRAITS: TraitName[] = ['clever', 'thoughtful', 'sociable', 'hard-working', 'cozy'];

export function ProfileCard({ pet, boughtByOwner, pastDebateCode, error, seal, onSealRetry, onRetry, onClose, onSkill, onMode, onWish, onFeed }: {
  pet: PetView;
  /** the outfit the owner bought first, which ended the wish (`add-pet-will › Wish pursuit flow › target bought by owner`) */
  boughtByOwner?: string | null;
  pastDebateCode?: string | null;
  error?: boolean;
  seal: SealState;
  onSealRetry: () => void;
  onRetry: () => void;
  onClose: () => void;
  onSkill?: () => void;
  onMode?: (mode: HireMode) => void;
  onWish?: () => void;
  onFeed?: () => void;
}) {
  const { tokenId, name } = pet;
  const owner = pet.viewer === 'owner';
  const asleep = pet.fullness.state === 'asleep';
  const returnFocusTo = () => document.querySelector<HTMLElement>('.ds-hud__nameplate');
  if (error) return <PetCard name={name} onClose={onClose} returnFocusTo={returnFocusTo}
    sections={[{ content: <Stack gap={2}><Note tone="error">{`Couldn't open ${name}'s card. Try again.`}</Note>
      <Button variant="secondary" size="compact" onClick={onRetry}>Try again</Button></Stack> }]} />;
  const sealNode = <Stack gap={2}>
    <Cluster gap={2} align="center">{seal.kind === 'checked' ? <Seal hash={seal.hash} size="sm" /> : null}
      {sealLine(name, seal) ? <Text variant="small" tone="secondary">{sealLine(name, seal)}</Text> : null}</Cluster>
    {seal.kind === 'unavailable' ? <Button variant="secondary" size="compact" onClick={onSealRetry}>Try again</Button> : null}
    <TextLink href={`/pet/${tokenId}/verify`} tone="trust" icon="verify">{`Check it's really ${name}`}</TextLink>
  </Stack>;
  const sections = owner ? [
    { title: 'Work', content: <Stack gap={2}>
      <TextLink href={workRecordPath(tokenId)} hit>View work record</TextLink>
      <TextLink href={experiencePath(tokenId)} hit>Review experience</TextLink>
      {asleep ? pet.skill?.label ? <Text variant="small">{`Good at ${pet.skill.label}`}</Text> : null
        : <Button variant="secondary" size="compact" icon="skill" onClick={onSkill}>{pet.skill?.label ? `${name}'s skill` : `Teach ${name} a skill`}</Button>}
      {asleep ? <Button variant="secondary" size="compact" icon="feed" onClick={onFeed}>{`Feed ${name}`}</Button>
        : <Stack gap={2}><Segmented label="Hiring" role="trust" value={pet.hireMode}
            options={[{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Ask me first' }]}
            onChange={(value) => onMode?.(value as HireMode)} />
          <Text variant="small" tone="secondary">{pet.hireMode === 'auto'
            ? `Hiring: Auto — ${name} asks pets it knows when they can help, then tells you what it cost.`
            : `Hiring: Ask me first — ${name} checks with you before paying another pet.`}</Text></Stack>}
    </Stack> },
    { title: 'Friends', content: <Stack gap={2}><TextLink href={relationshipsPath(tokenId)} hit>Relationships</TextLink>
      {pastDebateCode ? <TextLink href={debatePath(pastDebateCode)} hit>Past debates</TextLink> : null}</Stack> },
    { title: 'Wish', content: !pet.wish && boughtByOwner ? <Text variant="small">{`${name} already has ${nameOf(boughtByOwner) ?? boughtByOwner}.`}</Text>
      : !pet.wish && OUTFITS.filter((outfit) => outfit.kind === 'bought').every((outfit) => pet.outfits.includes(outfit.slug))
        ? <Text variant="small" tone="secondary">{`${name} has every outfit for now.`}</Text>
      : pet.wish ? <Stack gap={2}>
      <Text variant="small">{`${name} wants ${nameOf(pet.wish.item) ?? pet.wish.item}`}</Text>
      {asleep ? <Text variant="small">{`${name}'s wish`}</Text> : <TextLink href="#wish" hit onClick={onWish}>{`${name}'s wish`}</TextLink>}
      <Text variant="small" tone="secondary">{wishProgress(pet.wish, pet.outfitPrice).cents}</Text>
      <Text variant="small" tone="secondary">{wishProgress(pet.wish, pet.outfitPrice).near}</Text>
    </Stack> : <Text variant="small" tone="secondary">{`No wish yet for ${name}.`}</Text> },
  ] : [{ title: 'Work', content: <Stack gap={2}>
    {pet.skill?.label ? <Text variant="small">{`Good at ${pet.skill.label}`}</Text> : null}
    <TextLink href={workRecordPath(tokenId)}>View work record</TextLink>
  </Stack> }];
  return <PetCard name={name}
    portrait={<PetFigure tokenId={tokenId} name={name} stage={pet.stage} state={pet.fullness.state} size="md" still lost {...wearProps(pet.worn)} />}
    stage={owner ? pet.stage : undefined}
    traits={owner && pet.stage !== 'baby' ? Array.from(new Set(pet.traits)).filter((trait): trait is TraitName => TRAITS.includes(trait as TraitName)) : undefined}
    traitNote={owner && pet.stage === 'baby' ? `${name} gets a trait when it grows up.` : undefined}
    energy={owner ? pet.energy : undefined} fullness={owner ? undefined : pet.fullness.state}
    seal={sealNode} sections={sections} onClose={onClose} returnFocusTo={returnFocusTo} />;
}
