import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** tone: plain (off-white) | quiet (grey) | trust (the check's hue). `icon` / `iconEnd` / `external` / `hit` make it a
 *  standalone link on its own line with a full target. A native link: Enter follows it. */
export function TextLink({
  href,
  tone,
  icon,
  iconEnd,
  external,
  hit,
  onClick,
  onFollow,
  children,
}: {
  href: string;
  tone?: 'plain' | 'quiet' | 'trust';
  icon?: IconName;
  iconEnd?: IconName;
  external?: boolean;
  /** A full target with no icon (DS 0.48: the Hatch page's «Find a pet to ask»). */
  hit?: boolean;
  /** A local control styled as the frame's text link; the address is not followed. */
  onClick?: () => void;
  /** An event on a native navigation, without swallowing the link. */
  onFollow?: () => void;
  children?: ReactNode;
}) {
  const standalone = Boolean(icon || iconEnd || external || hit);
  return (
    <a
      className={cx('ds-link', tone && tone !== 'plain' && `ds-link--${tone}`, standalone && 'ds-link--standalone')}
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      onClick={onClick || onFollow ? (event) => { if (onClick) { event.preventDefault(); onClick(); } else onFollow?.(); } : undefined}
    >
      {icon ? <Icon name={icon} size="sm" /> : null}
      {standalone ? <span className="ds-link__label">{children}</span> : children}
      {external ? <Icon name="external" size="sm" /> : iconEnd ? <Icon name={iconEnd} size="sm" /> : null}
    </a>
  );
}
