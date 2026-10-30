import type { Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** Round, icon only: `label` is its accessible name. ghost | secondary (raised-2 + border — the Account control); `compact`
 *  is 32 px on the desktop. A native button: Enter and Space act. */
export function IconButton({
  icon,
  label,
  variant,
  size,
  href,
  disabled,
  onClick,
  expanded,
  haspopup,
  ref,
}: {
  icon: IconName;
  label: string;
  variant?: 'ghost' | 'secondary';
  size?: 'md' | 'compact';
  href?: string;
  disabled?: boolean;
  onClick?: () => void;
  expanded?: boolean;
  haspopup?: 'menu' | 'dialog';
  ref?: Ref<HTMLButtonElement & HTMLAnchorElement>;
}) {
  const className = cx('ds-icon-button', `ds-icon-button--${variant ?? 'ghost'}`, size === 'compact' && 'ds-icon-button--compact');
  if (href) {
    return (
      <a ref={ref} className={className} href={href} aria-label={label} aria-expanded={expanded} aria-haspopup={haspopup}>
        <Icon name={icon} />
      </a>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-haspopup={haspopup}
    >
      <Icon name={icon} />
    </button>
  );
}
