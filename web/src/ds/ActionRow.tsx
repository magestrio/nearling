import type { ReactNode } from 'react';
import { Dots } from './Dots';
import { Icon } from './Icon';
import { cx } from './util';

/** A full-width row that acts at once: the label left (with its price, «Feed · 5¢»), its note right («0.01 NEAR»).
 *  `pending` — the label becomes `pendingLabel` with the dots, busy, and it keeps the focus (aria-disabled, a repeat tap
 *  does nothing); `failed` — the alert mark before the label: the one that didn't go through. `disabled` — off, skipped by Tab. */
export function ActionRow({
  pending,
  pendingLabel,
  failed,
  disabled,
  price,
  aside,
  describedBy,
  onClick,
  children,
}: {
  pending?: boolean;
  pendingLabel?: string;
  failed?: boolean;
  disabled?: boolean;
  price?: string | null;
  aside?: ReactNode;
  describedBy?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const busy = Boolean(pending);
  return (
    <button
      type="button"
      className={cx('ds-action-row', busy && 'ds-action-row--pending')}
      disabled={Boolean(disabled)}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      aria-describedby={describedBy}
      onClick={busy ? undefined : onClick}
    >
      <span className="ds-action-row__label type-label">
        {busy ? <Dots /> : failed ? <Icon name="alert" size="sm" /> : null}
        {busy && pendingLabel ? (
          pendingLabel
        ) : (
          <>
            {children}
            {price != null ? ` · ${price}` : null}
          </>
        )}
      </span>
      {aside && !busy ? <span className="ds-action-row__aside type-small">{aside}</span> : null}
    </button>
  );
}
