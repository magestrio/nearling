import type { KeyboardEvent, ReactNode } from 'react';
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
  describedby,
  controls,
  menu,
  onClose,
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
  describedby?: string;
  controls?: string;
  menu?: ReactNode;
  onClose?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const inner = (
    <>
      <span className="ds-rail__disc">
        <Icon name={icon} size="lg" />
      </span>
      <span className="ds-rail__label type-small">{label}</span>
    </>
  );
  const item = href ? (
    <a className={cx('ds-rail__item', off && 'ds-rail__item--off')} href={href} data-role={role} aria-disabled={off || undefined} aria-describedby={describedby ?? describedBy}>
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
      aria-controls={controls}
      aria-disabled={off || undefined}
      aria-describedby={describedby ?? describedBy}
    >
      {inner}
    </button>
  );
  return menu ? <div className="ds-rail__entry" onKeyDown={(event) => {
    if (event.key === 'Escape' && expanded && onClose) {
      event.stopPropagation();
      onClose(event);
      event.currentTarget.querySelector<HTMLElement>('.ds-rail__item')?.focus();
    }
  }}>{item}{expanded ? menu : null}</div> : item;
}
