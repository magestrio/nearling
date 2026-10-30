import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** A vertical rail of labelled tiles beside the pet. Tab in DOM order; Enter follows a link or opens a sheet. */
export function Rail({ children }: { children?: ReactNode }) {
  return <div className="ds-rail">{children}</div>;
}

/** A link (`href`) to a screen, or a button that opens a sheet over this one. `role` — the meaning's hue on its icon. */
export function RailItem({
  href,
  onClick,
  icon,
  label,
  role,
  haspopup,
  expanded,
}: {
  href?: string;
  onClick?: () => void;
  icon: IconName;
  label: string;
  role?: 'food' | 'mind' | 'trust';
  haspopup?: 'menu' | 'dialog';
  expanded?: boolean;
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
    <a className="ds-rail__item" href={href} data-role={role}>
      {inner}
    </a>
  ) : (
    <button className="ds-rail__item" type="button" onClick={onClick} data-role={role} aria-haspopup={haspopup} aria-expanded={expanded}>
      {inner}
    </button>
  );
}
