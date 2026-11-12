import { useEffect, useRef, useState } from 'react';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

export type HotbarItem = { icon: IconName; label: string; lines?: string[]; href?: string; onClick?: () => void;
  more?: boolean; primary?: boolean; off?: boolean; role?: 'food' | 'mind' | 'trust'; expanded?: boolean; haspopup?: 'dialog' | 'menu' };

export function Hotbar({ items, menu = [], menuMessage, shareItems, active = true, onMenuReset }: {
  items: HotbarItem[]; menu?: ActionMenuItem[]; menuMessage?: string; shareItems?: ActionMenuItem[]; active?: boolean;
  /** the menu went back to its root or closed: what the caller said into `menuMessage` is spent */
  onMenuReset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const close = () => { setOpen(false); setSharing(false); onMenuReset?.(); requestAnimationFrame(() => moreRef.current?.focus()); };
  const choose = (item: ActionMenuItem) => {
    setOpen(false);
    setSharing(false);
    onMenuReset?.();
    item.onClick?.();
  };
  useEffect(() => {
    if (!active) { setOpen(false); setSharing(false); }
  }, [active]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (menu?.closest('[inert], [hidden]') || document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) return;
      menu?.querySelector<HTMLElement>('.ds-action-menu__item, .ds-action-menu__close')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, sharing]);
  return <nav className="ds-hotbar" aria-label="Pet actions">
    {items.map((item) => <div className="ds-hotbar__slot" key={item.label} ref={item.more ? (node) => { menuRef.current = node; } : undefined}>
      {item.more && open && active ? <ActionMenu items={sharing ? (menuMessage ? [] : (shareItems ?? [])) : menu.map((entry) => entry.icon === 'share' && shareItems
        ? { ...entry, onClick: () => setSharing(true) } : { ...entry, onClick: () => choose(entry) })} back={sharing ? () => { setSharing(false); onMenuReset?.(); } : undefined}
        message={menuMessage} onClose={close} /> : null}
      {item.href ? <a href={item.href} className={cx('ds-hotbar__action', item.primary && 'ds-hotbar__action--primary', item.off && 'ds-hotbar__action--off')}
        data-role={item.role} aria-disabled={item.off || undefined} onClick={item.off ? (event) => event.preventDefault() : item.onClick}
        aria-haspopup={item.haspopup} aria-expanded={item.expanded}>
        <span className="ds-hotbar__disc"><Icon name={item.icon} /></span>
        <span className="ds-hotbar__label type-small">{item.lines ? item.lines.map((line) => <span key={line}>{line}</span>) : item.label}</span>
      </a> : <button type="button" ref={item.more ? moreRef : undefined}
        className={cx('ds-hotbar__action', item.primary && 'ds-hotbar__action--primary', (item.off || (item.more && !active)) && 'ds-hotbar__action--off')}
        data-role={item.role} disabled={item.off || (item.more && !active)} aria-haspopup={item.more ? 'menu' : item.haspopup}
        aria-expanded={item.more ? open && active : item.expanded} onClick={item.more ? () => { if (open) close(); else setOpen(true); } : item.onClick}>
        <span className="ds-hotbar__disc"><Icon name={item.icon} /></span>
        <span className="ds-hotbar__label type-small">{item.lines ? item.lines.map((line) => <span key={line}>{line}</span>) : item.label}</span>
      </button>}
    </div>)}
  </nav>;
}
