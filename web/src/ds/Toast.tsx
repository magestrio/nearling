import { useEffect, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** How long a Toast stays (DS README › Toast). */
export const TOAST_MS = 4000;

/** An outcome, announced without moving the focus. `silent` — no live role, where a Sheet's status region or the page's
 *  Live says it; `inline` — drawn in place (the preview). It goes after `TOAST_MS`: `onDone` is called then. */
export function Toast({
  icon,
  silent,
  inline,
  onDone,
  children,
}: {
  icon?: IconName;
  silent?: boolean;
  inline?: boolean;
  onDone?: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!onDone) return undefined;
    const timer = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className={cx('ds-toast', inline && 'ds-toast--inline', 'type-body')} role={silent ? undefined : 'status'}>
      {icon ? (
        <span className="ds-toast__icon">
          <Icon name={icon} size="sm" />
        </span>
      ) : null}
      <span>{children}</span>
    </div>
  );
}
