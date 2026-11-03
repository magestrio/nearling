import { useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useReveal } from './reveal';
import { cx } from './util';

// DS 0.29 · design/ds/components.js › Console.

/** The Skill code sheet's test bench: a mono box with `title` (its line) and the output or the error's text as children. `tone:
 *  error` — the coral `alert` beside the title. No live role: the sheet's `status` says each run's outcome. `titleId` — the line's
 *  id, for the control it tells why («Test run» off at the cap); `reveal` — the run just made: the sheet's body scrolls it in. */
export function Console({ title, titleId, tone, reveal, children }: { title?: string; titleId?: string; tone?: 'error'; reveal?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useReveal(ref, reveal);
  return (
    <div className={cx('ds-console', tone === 'error' && 'ds-console--error')} ref={ref}>
      {title ? (
        <p className="type-body-strong ds-console__title" id={titleId}>
          {tone === 'error' ? (
            <span className="ds-console__icon">
              <Icon name="alert" size="sm" />
            </span>
          ) : null}
          <span>{title}</span>
        </p>
      ) : null}
      {children ? <pre className="type-mono ds-console__out">{children}</pre> : null}
    </div>
  );
}
