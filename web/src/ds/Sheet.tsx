import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton } from './IconButton';
import { cx, useIsDesktop } from './util';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A surface over the page. Desktop — a panel at the right with the page beside it live, phone — a bottom sheet over a scrim,
 *  modal (the screen marks what it covers `Inert`). `centered` — a dialog that stands alone (Clear memory, Sign-in closed),
 *  modal on both; `alert` — role `alertdialog` for an irreversible act: the focus lands on the element that carries
 *  `data-autofocus` (its safe action), never on the destructive one; `busy` — an act started from it is under way: «Close»
 *  is off, Esc and a tap on the scrim do nothing; `self` — it opened by itself, the focus lands on its title; `status` — its
 *  one live region (always mounted, the outcome is written by changing its text).
 *
 *  Focus: on open it moves into the sheet (`data-autofocus`, else the title for `self`, else the first control); on close it
 *  returns to the control that opened it, or to `returnFocusTo()` (a dialog opened from a menu item — the menu is gone by
 *  then). Esc and the close control close it; on the phone and in a modal Tab stays inside. */
export function Sheet({
  title,
  onClose,
  onBack,
  busy,
  status,
  head,
  column,
  popover,
  centered,
  alert,
  self,
  returnFocusTo,
  children,
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  busy?: boolean;
  status?: string;
  head?: ReactNode;
  column?: boolean;
  popover?: boolean;
  centered?: boolean;
  alert?: boolean;
  self?: boolean;
  returnFocusTo?: () => HTMLElement | null;
  children?: ReactNode;
}) {
  const titleId = useId();
  const sheet = useRef<HTMLElement>(null);
  const desktop = useIsDesktop();
  const modal = Boolean(centered) || !desktop;
  const latest = useRef({ onClose, busy, returnFocusTo });
  latest.current = { onClose, busy, returnFocusTo };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = sheet.current;
    const target = root?.querySelector<HTMLElement>('[data-autofocus]') ?? (self ? root?.querySelector<HTMLElement>('h2') : null) ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      const back = latest.current.returnFocusTo?.() ?? opener;
      if (back?.isConnected) back.focus();
    };
  }, [self]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || latest.current.busy) return;
      e.preventDefault();
      latest.current.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const keepTabInside = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !modal) return;
    const all = Array.from(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = all[0];
    const last = all[all.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={cx('ds-sheet-layer', column && 'ds-sheet-layer--column', popover && 'ds-sheet-layer--popover', centered && 'ds-sheet-layer--centered')}>
      <div className="ds-sheet__scrim" aria-hidden="true" onClick={busy ? undefined : onClose} />
      <section
        ref={sheet}
        className="ds-sheet"
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal={modal ? 'true' : undefined}
        aria-labelledby={titleId}
        onKeyDown={keepTabInside}
      >
        <div className="ds-sheet__head">
          {onBack ? <IconButton icon="back" label="Back" size="compact" onClick={onBack} /> : null}
          <h2 id={titleId} className="ds-sheet__title type-title-3" tabIndex={self ? -1 : undefined}>
            {title}
          </h2>
          <IconButton icon="close" label="Close" size="compact" disabled={busy} onClick={onClose} />
        </div>
        {/* one live region, always there: each outcome is written into it by changing its text */}
        <p className="ds-hidden" role="status">
          {status ?? ''}
        </p>
        {head ? <div className="ds-sheet__sub">{head}</div> : null}
        <div className="ds-sheet__body">{children}</div>
      </section>
    </div>
  );
}
