import type { ReactNode } from 'react';
import { Live } from './Live';
import { cx, useIsDesktop } from './util';

/** One object (or a form) and its actions: on the phone the actions are pinned to the bottom, on the desktop they
 *  stand right under the object. `text` — the words that go with the object. `scroll` — a form over its action (the
 *  Hatch screen): on the phone the body scrolls as a region named by `labelledBy` and the actions stay pinned.
 *  What scrolls is a region named by the page's h1 and takes the focus, so Tab reaches it before the action and
 *  the arrows and Page Up/Down scroll it. `status` — the page's live region, always there. */
export function Centerpiece({
  text,
  scroll,
  labelledBy,
  actions,
  status,
  children,
}: {
  text?: ReactNode;
  scroll?: boolean;
  labelledBy?: string;
  actions?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}) {
  const hasText = Boolean(text);
  const region = hasText || scroll ? { role: 'region', 'aria-labelledby': labelledBy, tabIndex: 0 } : undefined;
  const desktop = useIsDesktop();
  return (
    <div className={cx('ds-centerpiece', hasText && 'ds-centerpiece--text', scroll && 'ds-centerpiece--scroll')} {...(desktop && hasText ? region : undefined)}>
      <div className="ds-centerpiece__body" {...(desktop ? undefined : region)}>
        {text ? <div className="ds-centerpiece__object">{children}</div> : children}
        {text ? <div className="ds-centerpiece__text">{text}</div> : null}
      </div>
      {actions ? <div className="ds-centerpiece__actions">{actions}</div> : null}
      {status !== undefined ? <Live>{status}</Live> : null}
    </div>
  );
}
