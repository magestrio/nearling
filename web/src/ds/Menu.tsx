import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** A dropdown of actions under the header's end control that opened it (the Account menu). `note` is a line above the
 *  items, not one of them. The focus lands on the `first` item when it opens; Up / Down move between the items, Home / End
 *  go to the ends, Esc and Tab ask to close it (`onClose`): after Esc the opener takes the focus back, after Tab the focus
 *  goes on. */
export function Menu({
  label,
  note,
  onClose,
  children,
}: {
  label: string;
  note?: ReactNode;
  onClose: (by: 'escape' | 'tab') => void;
  children?: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const items = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[role="menuitem"][tabindex="0"]')?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = (i: number) => {
      e.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (e.key === 'ArrowDown') to(at + 1);
    else if (e.key === 'ArrowUp') to(at < 0 ? -1 : at - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(-1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      onClose('escape');
    } else if (e.key === 'Tab') onClose('tab');
  };

  return (
    <div className="ds-menu-layer">
      <div className="ds-menu" onKeyDown={onKeyDown}>
        {note ? <p className="ds-menu__note type-small">{note}</p> : null}
        <ul ref={list} className="ds-menu__list" role="menu" aria-label={label}>
          {children}
        </ul>
      </div>
    </div>
  );
}

/** One action of a Menu; `first` is the item the focus lands on when the menu opens (roving tabindex). */
export function MenuItem({
  first,
  icon,
  haspopup,
  onClick,
  children,
}: {
  first?: boolean;
  icon?: IconName;
  haspopup?: 'dialog';
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <li role="none">
      <button type="button" className="ds-menu__item type-body" role="menuitem" tabIndex={first ? 0 : -1} aria-haspopup={haspopup} onClick={onClick}>
        {icon ? <Icon name={icon} /> : null}
        <span>{children}</span>
      </button>
    </li>
  );
}
