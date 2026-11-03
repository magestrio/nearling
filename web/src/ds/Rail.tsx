import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** A vertical rail of labelled tiles beside the pet. Tab in DOM order; Enter follows a link or opens a sheet. */
export function Rail({ children }: { children?: ReactNode }) {
  return <div className="ds-rail">{children}</div>;
}

/** A link (`href`) to a screen, or a button that opens a sheet over this one. `role` — the meaning's hue on its icon. `off` —
 *  unavailable now (the pet is out on an errand): drawn off, `aria-disabled` so a focus on it stays, Enter does nothing;
 *  `describedBy` — the id of the line that says why. */
export function RailItem({
  href,
  onClick,
  icon,
  label,
  role,
  haspopup,
  expanded,
  off,
  describedBy,
}: {
  href?: string;
  onClick?: () => void;
  icon: IconName;
  label: string;
  role?: 'food' | 'mind' | 'trust';
  haspopup?: 'menu' | 'dialog';
  expanded?: boolean;
  off?: boolean;
  describedBy?: string;
}) {
  const inner = (
    <>
      <span className="ds-rail__disc">
        <Icon name={icon} size="lg" />
      </span>
      <span className="ds-rail__label type-small">{label}</span>
    </>
  );
  return href ? (
    <a className={cx('ds-rail__item', off && 'ds-rail__item--off')} href={href} data-role={role} aria-disabled={off || undefined} aria-describedby={describedBy}>
      {inner}
    </a>
  ) : (
    <button
      className={cx('ds-rail__item', off && 'ds-rail__item--off')}
      type="button"
      onClick={off ? undefined : onClick}
      data-role={role}
      aria-haspopup={haspopup}
      aria-expanded={expanded}
      aria-disabled={off || undefined}
      aria-describedby={describedBy}
    >
      {inner}
    </button>
  );
}
