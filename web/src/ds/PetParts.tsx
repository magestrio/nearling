import type { ElementType, ReactNode } from 'react';
import { Fullness, type FullnessState } from './Fullness';
import { Icon, type IconName } from './Icon';
import { Seal } from './Verification';
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
 *  owner's extras as children. `level` — the heading level (0 for no heading). `badge` — the SkillBadge, right under the
 *  name (on the phone's compact plate, its own row under the name and the energy). */
export function PetPlate({
  name,
  size,
  level,
  align,
  compact,
  badge,
  seal,
  fullness,
  action,
  children,
}: {
  name: string;
  size?: 'display' | 'title';
  level?: 0 | 1 | 2 | 3;
  align?: 'start';
  compact?: boolean;
  badge?: ReactNode;
  /** The checked on-chain character mark, beside the name. */
  seal?: string;
  fullness?: { state?: FullnessState; level?: number };
  action?: ReactNode;
  children?: ReactNode;
}) {
  const Tag = (level === 0 ? 'p' : `h${level ?? 1}`) as ElementType;
  return (
    <div className={cx('ds-plate', align === 'start' && 'ds-plate--start', compact && 'ds-plate--compact')}>
      {seal ? <div className="ds-plate__head"><Tag className={cx('ds-plate__name', size === 'title' ? 'type-title-2' : 'type-display')}>{name}</Tag><Seal hash={seal} /></div>
        : <Tag className={cx('ds-plate__name', size === 'title' ? 'type-title-2' : 'type-display')}>{name}</Tag>}
      {badge ? <div className="ds-plate__badge">{badge}</div> : null}
      <div className="ds-plate__state">
        <Fullness {...(fullness ?? {})} />
        {action ?? null}
      </div>
      {children ? <div className="ds-plate__extras">{children}</div> : null}
    </div>
  );
}

/** The pet's skill under its name (`add-pet-work` › `Skill rule` › «label on the pet's page»): «Good at {label}» with the skill's
 *  gem, for every viewer, inert; a pet with no skill shows nothing to anyone else. `owner` — a button that opens Skill sheet: with a
 *  `label` it is the badge itself, named «{name}'s skill: Good at {label}»; with none, a dashed slot «Teach {name} a skill».
 *  `expanded` — its sheet is open. */
export function SkillBadge({
  name,
  label,
  owner,
  expanded,
  preview,
  onClick,
}: {
  name: string;
  label?: string | null;
  owner?: boolean;
  expanded?: boolean;
  /** on Skill sheet: the label as typed and not saved — dashed and grey, hidden from a screen reader (the field says it) */
  preview?: boolean;
  onClick?: () => void;
}) {
  const text = label ? `Good at ${label}` : `Teach ${name} a skill`;
  const inner = (
    <>
      <Icon name="skill" size="sm" />
      <span>{text}</span>
    </>
  );
  if (preview) return label ? <p className="ds-skill-badge ds-skill-badge--preview type-label" aria-hidden="true">{inner}</p> : null;
  if (!owner) return label ? <p className="ds-skill-badge type-label">{inner}</p> : null;
  return (
    <button
      type="button"
      className={cx('ds-skill-badge', 'ds-skill-badge--button', !label && 'ds-skill-badge--empty', 'type-label')}
      aria-label={label ? `${name}'s skill: ${text}` : undefined}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
    >
      {inner}
    </button>
  );
}

/** The pet's zone: the pet and its rail as one tight pair, the plate and a foot line under the pet. `compact` — the
 *  owner's phone. `owner` — the owner's stage, awake or asleep: on the phone the pet takes the owner's smaller cap.
 *  `motion` — the MotionToggle, in the corner of the pet's figure. */
export function PetStage({
  pet,
  rail,
  plate,
  foot,
  motion,
  compact,
  owner,
}: {
  pet: ReactNode;
  rail?: ReactNode;
  plate?: ReactNode;
  foot?: ReactNode;
  motion?: ReactNode;
  compact?: boolean;
  owner?: boolean;
}) {
  return (
    <div className={cx('ds-stage', !rail && 'ds-stage--bare', compact && 'ds-stage--compact', owner && 'ds-stage--owner')}>
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
