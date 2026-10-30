import type { CSSProperties } from 'react';
import { cx } from './util';

/** Three dots — the pet's thinking face — for any wait. Hidden from screen readers; the words beside them speak.
 *  The pulse count and its stop (WCAG 2.2.2) are components.css's, as is the reduced-motion stillness. */
export function Dots({ accent }: { accent?: boolean }) {
  return (
    <span className={cx('ds-dots', accent && 'ds-dots--accent')} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="ds-dots__dot" style={{ '--i': i } as CSSProperties} />
      ))}
    </span>
  );
}
