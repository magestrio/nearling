import type { ElementType, ReactNode } from 'react';
import { Fullness, type FullnessState } from './Fullness';
import { cx } from './util';

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
