import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './util';

/** The app-wide line when the server, NEAR or the AI can't be reached: what happened, what to do, the action. No live
 *  role of its own (mounted with its words it would not be heard): the screen writes them into a Live. */
export function Banner({ tone = 'error', action, children }: { tone?: 'error' | 'info'; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx('ds-banner', `ds-banner--${tone}`)}>
      <div className="ds-banner__body">
        {tone === 'error' ? (
          <span className="ds-banner__icon">
            <Icon name="alert" />
          </span>
        ) : null}
        <span className="type-body">{children}</span>
      </div>
      {action ? <div className="ds-banner__action">{action}</div> : null}
    </div>
  );
}

/** The shape of what is loading: line | short | name | pet. Never a full-page spinner. */
export function Skeleton({ shape = 'line' }: { shape?: 'line' | 'short' | 'name' | 'pet' }) {
  return <span className={`ds-skeleton ds-skeleton--${shape}`} aria-hidden="true" />;
}

/** Where a pet will stand before it exists (the Hatch screen): its light on the ground, no shape. `busy` — the light
 *  breathes while it hatches. */
export function Nest({ busy }: { busy?: boolean }) {
  return <div className={cx('ds-nest', busy && 'ds-nest--busy')} aria-hidden="true" />;
}
