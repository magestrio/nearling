import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';
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
  foot,
  wide,
  closeText,
  closeLabel = 'Close',
  returnFocusTo,
  inert,
  hidden,
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
  /** the sheet's actions under its body, outside its scroll, a hairline above (Errand sheet's «Send · …») */
  foot?: ReactNode;
  /** the Skill code sheet: with `centered` a dialog as wide as the content column on the desktop, on the phone the bottom
   *  sheet at its full height */
  wide?: boolean;
  /** «Close» as a text button instead of the icon (the Pet card) */
  closeText?: boolean;
  closeLabel?: string;
  returnFocusTo?: () => HTMLElement | null;
  /** a sheet over this one: this one is out of reach. On the layer itself, so a column sheet stays a direct child of the main
   *  (the Stage's CSS places it by that), which a wrapping `Inert` would break */
  inert?: boolean;
  /** kept in the page, not drawn (a step of the sheet stands: its opener stays for the step's «Back») */
  hidden?: boolean;
  children?: ReactNode;
}) {
  const titleId = useId();
  const sheet = useRef<HTMLElement>(null);
  const desktop = useIsDesktop();
  const modal = Boolean(centered) || !desktop;
  const latest = useRef({ onClose, busy, returnFocusTo });
  latest.current = { onClose, busy, returnFocusTo };
  // read before the commit that marks the page under the sheet inert: an inert opener can't take the focus back, so an
  // effect that ran again (StrictMode) would read the sheet's own control
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const root = sheet.current;
    // typing means a field with words in it: the Composer's autofocus on an empty field is not the player's line
    if (self && document.activeElement instanceof HTMLTextAreaElement && document.activeElement.value !== '' && !root?.contains(document.activeElement)) return;
    const target = root?.querySelector<HTMLElement>('[data-autofocus]') ?? (self ? root?.querySelector<HTMLElement>('h2') : null) ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      const back = latest.current.returnFocusTo?.() ?? opener;
      if (back?.isConnected) back.focus();
    };
  }, [self, opener]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || latest.current.busy) return;
      // a sheet the page marked `inert` (another sheet opened over it), or hid while a step of it stands, is out of reach: Esc closes
      // the one on top
      if (sheet.current?.closest('[inert], [hidden]')) return;
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
    <div className={cx('ds-sheet-layer', column && 'ds-sheet-layer--column', popover && 'ds-sheet-layer--popover', centered && 'ds-sheet-layer--centered', wide && 'ds-sheet-layer--wide')}
      inert={inert || undefined} hidden={hidden || undefined} style={hidden ? { display: 'none' } : undefined}>
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
          {closeText ? <Button variant="ghost" size="compact" disabled={busy} onClick={onClose}>{closeLabel}</Button>
            : <IconButton icon="close" label={closeLabel} size="compact" disabled={busy} onClick={onClose} />}
        </div>
        {/* one live region, always there: each outcome is written into it by changing its text */}
        <p className="ds-hidden" role="status">
          {status ?? ''}
        </p>
        {head ? <div className="ds-sheet__sub">{head}</div> : null}
        <div className="ds-sheet__body">{children}</div>
        {foot ? <div className="ds-sheet__foot">{foot}</div> : null}
      </section>
    </div>
  );
}
