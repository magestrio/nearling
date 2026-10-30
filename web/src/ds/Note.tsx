import type { ReactNode } from 'react';
import { Dots } from './Dots';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** A line at the field or the action it is about. tone: hint (grey) | plain | error (the coral icon, role=alert) |
 *  status (the dots, role=status). `silent` — no live role, when a status region elsewhere announces it.
 *  `tabIndex` −1 when the focus goes to it after an outcome. */
export function Note({
  tone = 'hint',
  icon,
  silent,
  id,
  tabIndex,
  children,
}: {
  tone?: 'hint' | 'plain' | 'error' | 'status';
  icon?: IconName;
  silent?: boolean;
  id?: string;
  tabIndex?: number;
  children?: ReactNode;
}) {
  const mark = tone === 'error' ? <Icon name="alert" size="sm" /> : tone === 'status' ? <Dots /> : icon ? <Icon name={icon} size="sm" /> : null;
  const role = silent ? undefined : tone === 'error' ? 'alert' : tone === 'status' ? 'status' : undefined;
  return (
    <p className={cx('ds-note', `ds-note--${tone}`, 'type-small')} id={id} tabIndex={tabIndex} role={role}>
      {mark ? <span className="ds-note__icon">{mark}</span> : null}
      <span>{children}</span>
    </p>
  );
}
