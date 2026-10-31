import type { ElementType, ReactNode } from 'react';
import { Fullness, type FullnessState } from './Fullness';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** Ten steps: each «Think hard» and each job takes one. `label` — the words the spec gives it, shown and used as its
 *  name; without it the meter is a drawing (`data-illustration`), the bolt part of it. */
export function Energy({ value, label, max = 10 }: { value: number; label?: string; max?: number }) {
  return (
    <div
      className="ds-energy"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      data-illustration={label ? undefined : ''}
    >
      <Icon name="bolt" size="sm" />
      {label ? <span className="ds-energy__label type-small">{label}</span> : null}
      <span className="ds-energy__bars" aria-hidden="true">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={cx('ds-energy__bar', i < value && 'ds-energy__bar--on')} />
        ))}
      </span>
    </div>
  );
}

export type StageName = 'baby' | 'teen' | 'adult';
const STAGE_WORD: Record<StageName, string> = { baby: 'Baby', teen: 'Teen', adult: 'Grown-up' };
const STAGE_STEPS: Record<StageName, number> = { baby: 1, teen: 2, adult: 3 };

/** The stage as three steps (the passed ones filled) and its word, shown to the owner. Not a control. */
export function Growth({ stage = 'adult' }: { stage?: StageName }) {
  const n = STAGE_STEPS[stage];
  const steps = [];
  for (let i = 1; i <= 3; i += 1) {
    if (i > 1) steps.push(<span key={`l${i}`} className={cx('ds-growth__link', i <= n && 'ds-growth__link--on')} />);
    steps.push(<span key={`d${i}`} className={cx('ds-growth__dot', i <= n && 'ds-growth__dot--on')} />);
  }
  return (
    <span className="ds-growth type-label">
      <span className="ds-growth__steps" aria-hidden="true">
        {steps}
      </span>
      {STAGE_WORD[stage]}
    </span>
  );
}

export type TraitName = 'clever' | 'thoughtful' | 'sociable' | 'hard-working' | 'cozy';
const TRAIT_TILE: Record<TraitName, { icon: IconName; role?: string }> = {
  clever: { icon: 'puzzle', role: 'mind' },
  thoughtful: { icon: 'bulb', role: 'mind' },
  sociable: { icon: 'friends', role: 'food' },
  'hard-working': { icon: 'bag', role: 'trust' },
  cozy: { icon: 'cup' },
};

/** A trait: the icon of the deed it comes from, in that deed's hue, and its word. Not a control. */
export function Trait({ name }: { name: TraitName }) {
  const tile = TRAIT_TILE[name];
  return (
    <span className="ds-trait type-label">
      <span className="ds-trait__tile" data-role={tile.role}>
        <Icon name={tile.icon} />
      </span>
      {name}
    </span>
  );
}

/** Under the pet, where its light falls: the name in its one slot, its Fullness with the action beside it, then the
 *  owner's extras as children. `level` — the heading level (0 for no heading). */
export function PetPlate({
  name,
  size,
  level,
  align,
  compact,
  fullness,
  action,
  children,
}: {
  name: string;
  size?: 'display' | 'title';
  level?: 0 | 1 | 2 | 3;
  align?: 'start';
  compact?: boolean;
  fullness?: { state?: FullnessState; level?: number };
  action?: ReactNode;
  children?: ReactNode;
}) {
  const Tag = (level === 0 ? 'p' : `h${level ?? 1}`) as ElementType;
  return (
    <div className={cx('ds-plate', align === 'start' && 'ds-plate--start', compact && 'ds-plate--compact')}>
      <Tag className={cx('ds-plate__name', size === 'title' ? 'type-title-2' : 'type-display')}>{name}</Tag>
      <div className="ds-plate__state">
        <Fullness {...(fullness ?? {})} />
        {action ?? null}
      </div>
      {children ? <div className="ds-plate__extras">{children}</div> : null}
    </div>
  );
}

/** The pet's zone: the pet and its rail as one tight pair, the plate and a foot line under the pet. `compact` — the
 *  owner's phone. `motion` — the MotionToggle, in the corner of the pet's figure. */
export function PetStage({
  pet,
  rail,
  plate,
  foot,
  motion,
  compact,
}: {
  pet: ReactNode;
  rail?: ReactNode;
  plate?: ReactNode;
  foot?: ReactNode;
  motion?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('ds-stage', !rail && 'ds-stage--bare', compact && 'ds-stage--compact')}>
      <div className="ds-stage__pet">
        {motion ? (
          <div className="ds-stage__figure">
            {pet}
            <div className="ds-stage__motion">{motion}</div>
          </div>
        ) : (
          pet
        )}
      </div>
      {rail ? <div className="ds-stage__rail">{rail}</div> : null}
      {plate ? <div className="ds-stage__plate">{plate}</div> : null}
      {foot ? <div className="ds-stage__foot">{foot}</div> : null}
    </div>
  );
}
