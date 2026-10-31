import type { CSSProperties, ElementType, ReactNode } from 'react';
import { cx, gap, useIsDesktop } from './util';

export type Accent = 'mint' | 'aqua' | 'lavender' | 'coral' | 'yellow' | 'none';

/** The page: the accent of the shown pet (none — no pet), the header, the main. `fill` — the page is the viewport
 *  and one area inside scrolls. */
export function Shell({ accent, fill, header, children }: { accent?: Accent; fill?: boolean; header?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx('ds-shell', fill && 'ds-shell--fill')} data-accent={accent ?? 'none'}>
      {header ?? null}
      <main className="ds-shell__main">{children}</main>
    </div>
  );
}

export function Header({ start, end }: { start?: ReactNode; end?: ReactNode }) {
  return (
    <header className="ds-header">
      <div className="ds-header__inner">
        <div className="ds-header__start">{start}</div>
        <div className="ds-header__end">{end}</div>
      </div>
    </header>
  );
}

/** width: wide (the default) | default | narrow */
export function Page({ width, fill, children }: { width?: 'wide' | 'default' | 'narrow'; fill?: boolean; children?: ReactNode }) {
  return <div className={cx('ds-page', width && width !== 'wide' && `ds-page--${width}`, fill && 'ds-page--fill')}>{children}</div>;
}

export function Stack({
  as: Tag = 'div',
  gap: g,
  align,
  justify,
  grow,
  children,
}: {
  as?: ElementType;
  gap?: number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  grow?: boolean;
  children?: ReactNode;
}) {
  return (
    <Tag
      className="ds-stack"
      style={{ gap: gap(g ?? 4), alignItems: align, justifyContent: justify, flex: grow ? '1 1 auto' : undefined, minHeight: grow ? 'var(--space-0)' : undefined }}
    >
      {children}
    </Tag>
  );
}

export function Cluster({
  as: Tag = 'div',
  gap: g,
  align,
  justify,
  nowrap,
  children,
}: {
  as?: ElementType;
  gap?: number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  nowrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <Tag className="ds-cluster" style={{ gap: gap(g ?? 3), alignItems: align, justifyContent: justify, flexWrap: nowrap ? 'nowrap' : undefined }}>
      {children}
    </Tag>
  );
}

/** Two columns on desktop, one on the phone, in DOM order. */
export function Split({ ratio, fill, start, end }: { ratio?: 'even' | 'start' | 'end'; fill?: boolean; start?: ReactNode; end?: ReactNode }) {
  return (
    <div className={cx('ds-split', ratio && ratio !== 'even' && `ds-split--${ratio}`, fill && 'ds-split--fill')}>
      <div className="ds-split__start">{start}</div>
      <div className="ds-split__end">{end}</div>
    </div>
  );
}

export function Center({ children }: { children?: ReactNode }) {
  return <div className="ds-center">{children}</div>;
}

export function Dock({ children }: { children?: ReactNode }) {
  return <div className="ds-dock">{children}</div>;
}

/** The actions of one moment that stand as peers (Home's «Hatch your pet» and «Sign in»): stacked and full width on the
 *  phone, side by side and centred on the desktop. Not a control: no motion, hover, focus or keys of its own. */
export function Actions({ children }: { children?: ReactNode }) {
  return <div className="ds-actions">{children}</div>;
}

/** Content that stands in a different place on each viewport: where it shows it adds no box of its own. */
export function Only({ on, children }: { on: 'phone' | 'desktop'; children?: ReactNode }) {
  return <div className={`ds-only ds-only--${on}`}>{children}</div>;
}

/** What a modal sheet covers: out of reach for focus, the pointer and a screen reader; no box.
 *  on: true — inert on both viewports; 'phone' — only where a sheet is modal.
 *  The same element whether on or not: one that came and went would remount all it covers — the pet's one canvas, the
 *  sheet's opener, the conversation's scroll. */
export function Inert({ on, children }: { on?: boolean | 'phone'; children?: ReactNode }) {
  const desktop = useIsDesktop();
  const active = on === 'phone' ? !desktop : Boolean(on);
  return (
    <div className="ds-only" inert={active || undefined}>
      {children}
    </div>
  );
}
