import type { ElementType, ReactNode } from 'react';
import { cx } from './util';

export function Text({
  as: Tag = 'p',
  variant = 'body',
  tone,
  tabular,
  align,
  measure,
  id,
  role,
  tabIndex,
  children,
}: {
  as?: ElementType;
  variant?: string;
  tone?: 'primary' | 'secondary';
  tabular?: boolean;
  align?: 'center';
  measure?: boolean;
  id?: string;
  role?: string;
  tabIndex?: number;
  children?: ReactNode;
}) {
  return (
    <Tag
      className={cx('ds-text', `type-${variant}`, tone && tone !== 'primary' && `ds-text--${tone}`, tabular && 'ds-tabular', align === 'center' && 'ds-text--center', measure && 'ds-text--measure')}
      id={id}
      role={role}
      tabIndex={tabIndex}
    >
      {children}
    </Tag>
  );
}

const HEADING_STYLE: Record<number, string> = { 1: 'title-1', 2: 'title-2', 3: 'title-3', 4: 'body-strong' };

/** `hidden` — the page's h1 for a screen reader only, when the screen shows no heading of its own. */
export function Heading({
  level = 2,
  variant,
  wide,
  align,
  measure,
  hidden,
  id,
  tabIndex,
  children,
}: {
  level?: 1 | 2 | 3 | 4;
  variant?: string;
  wide?: boolean;
  align?: 'center';
  measure?: boolean;
  hidden?: boolean;
  id?: string;
  tabIndex?: number;
  children?: ReactNode;
}) {
  const Tag = `h${level}` as ElementType;
  return (
    <Tag
      className={cx('ds-heading', `type-${variant ?? HEADING_STYLE[level]}`, wide && 'ds-heading--wide', align === 'center' && 'ds-heading--center', measure && 'ds-text--measure', hidden && 'ds-hidden')}
      id={id}
      tabIndex={tabIndex}
    >
      {children}
    </Tag>
  );
}

/** Text for a screen reader only. */
export function Hidden({ children, id }: { children?: ReactNode; id?: string }) {
  return <span className="ds-hidden" id={id}>{children}</span>;
}
