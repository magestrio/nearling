import type { ReactNode } from 'react';

/** A live region that stays on the page from the start: its text changes, it is never mounted together with it.
 *  `alert` — an error after the player's own action, said at once; otherwise polite. Visually hidden: what it says is
 *  also drawn, silent, where the player sees it. */
export function Live({ alert, children }: { alert?: boolean; children?: ReactNode }) {
  return (
    <p className="ds-hidden" role={alert ? 'alert' : 'status'}>
      {children ?? ''}
    </p>
  );
}
