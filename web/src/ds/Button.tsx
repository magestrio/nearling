import { useId, type ReactNode } from 'react';
import { Dots } from './Dots';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

export interface ButtonProps {
  /** primary (the one action of a state) | secondary (a control next to the pet) | ghost | danger */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** the meaning's hue on the icon of a secondary or ghost button */
  role?: 'food' | 'mind' | 'trust';
  size?: 'md' | 'compact';
  block?: boolean;
  /** the label never wraps and the button never shrinks (a foot that shares its row) */
  nowrap?: boolean;
  icon?: IconName;
  iconEnd?: IconName;
  /** shown after the label as «Label · {price}» */
  price?: string | null;
  /** the label becomes `pendingLabel`, the button is off and busy, and keeps the focus */
  pending?: boolean;
  pendingLabel?: string;
  /** off while something it waits for is under way: drawn off, keeps the focus (aria-disabled) */
  busy?: boolean;
  /** unavailable now, with its reason beside it: drawn as disabled, aria-disabled, the focus stays */
  off?: boolean;
  /** only where nothing can have focused it (loading) */
  disabled?: boolean;
  /** a link that navigates, drawn as a button */
  href?: string;
  type?: 'button' | 'submit';
  onClick?: () => void;
  describedBy?: string;
  /** the id of what completes the name where the label alone repeats in a list */
  nameWith?: string;
  expanded?: boolean;
  haspopup?: 'menu' | 'dialog';
  /** Sheet moves focus here when it opens. */
  focusOnOpen?: boolean;
  pressed?: boolean;
  children?: ReactNode;
}

export function Button(p: ButtonProps) {
  const labelId = useId();
  const pending = Boolean(p.pending) || Boolean(p.busy);
  const held = Boolean(p.off);
  const off = Boolean(p.disabled);
  const label = pending && p.pendingLabel ? p.pendingLabel : p.children;
  const content = (
    <>
      {p.pending ? <Dots /> : p.icon ? <Icon name={p.icon} /> : null}
      <span className="ds-button__label" id={p.nameWith ? labelId : undefined}>
        {label}
        {!p.pending && p.price != null ? (
          <>
            {' · '}
            <span className="ds-button__price">{p.price}</span>
          </>
        ) : null}
      </span>
      {!p.pending && p.iconEnd ? <Icon name={p.iconEnd} /> : null}
    </>
  );
  const className = cx(
    'ds-button',
    `ds-button--${p.variant ?? 'primary'}`,
    'type-label',
    p.size === 'compact' && 'ds-button--compact',
    p.nowrap && 'ds-button--nowrap',
    p.block && 'ds-button--block',
    p.busy ? 'ds-button--busy' : pending && 'ds-button--pending',
    held && 'ds-button--off',
  );
  if (p.href && !off && !pending) {
    return (
      <a className={className} href={p.href} data-role={p.role} aria-describedby={p.describedBy}>
        {content}
      </a>
    );
  }
  return (
    <button
      data-autofocus={p.focusOnOpen ? '' : undefined}
      // pending, busy and off keep the focus (aria-disabled) and a repeat tap does nothing
      type={p.type ?? 'button'}
      className={className}
      disabled={off}
      // a submit button that is off must not submit its form either
      onClick={pending || held ? (e) => e.preventDefault() : p.onClick}
      data-role={p.role}
      aria-busy={pending || undefined}
      aria-disabled={pending || held || undefined}
      aria-describedby={p.describedBy}
      aria-labelledby={p.nameWith ? `${labelId} ${p.nameWith}` : undefined}
      aria-expanded={p.expanded}
      aria-haspopup={p.haspopup}
      aria-pressed={p.pressed}
    >
      {content}
    </button>
  );
}

