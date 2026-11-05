import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** tone: plain (off-white) | quiet (grey) | trust (the check's hue). `icon` / `iconEnd` / `external` make it a
 *  standalone link on its own line with a full target. A native link: Enter follows it. */
export function TextLink({
  href,
  tone,
  icon,
  iconEnd,
  external,
  onClick,
  children,
}: {
  href: string;
  tone?: 'plain' | 'quiet' | 'trust';
  icon?: IconName;
  iconEnd?: IconName;
  external?: boolean;
  /** A local control styled as the frame's text link; the address is not followed. */
  onClick?: () => void;
  children?: ReactNode;
}) {
  const standalone = Boolean(icon || iconEnd || external);
  return (
    <a
      className={cx('ds-link', tone && tone !== 'plain' && `ds-link--${tone}`, standalone && 'ds-link--standalone')}
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      onClick={onClick ? (event) => { event.preventDefault(); onClick(); } : undefined}
    >
      {icon ? <Icon name={icon} size="sm" /> : null}
      {standalone ? <span className="ds-link__label">{children}</span> : children}
      {external ? <Icon name="external" size="sm" /> : iconEnd ? <Icon name={iconEnd} size="sm" /> : null}
    </a>
  );
}
