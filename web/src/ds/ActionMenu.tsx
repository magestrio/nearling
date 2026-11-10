import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';

export type ActionMenuItem = { icon: IconName; label: string; href?: string; onClick?: () => void; haspopup?: 'dialog' | 'menu'; expanded?: boolean };

export function ActionMenu({ items, back, message, onClose }: {
  items: ActionMenuItem[]; back?: () => void; message?: string; onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message && !menuRef.current?.contains(document.activeElement)) messageRef.current?.focus();
  }, [message]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href]'));
    const current = controls.indexOf(document.activeElement as HTMLElement);
    if (!controls.length) return;
    event.preventDefault();
    controls[(current + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length]?.focus();
  };
  return <div ref={menuRef} className="ds-action-menu" role="menu" aria-label="More" onKeyDown={onKeyDown}>
    <div className="ds-action-menu__head type-label">More</div>
    {back ? <button type="button" className="ds-action-menu__item type-label" role="menuitem" onClick={back}>Back</button> : null}
    {items.map((item) => item.href
      ? <a key={item.label} href={item.href} className="ds-action-menu__item type-label" role="menuitem" onClick={item.onClick} aria-haspopup={item.haspopup} aria-expanded={item.expanded}>
          <Icon name={item.icon} /><span>{item.label}</span>
        </a>
      : <button key={item.label} type="button" className="ds-action-menu__item type-label" role="menuitem" onClick={item.onClick} aria-haspopup={item.haspopup} aria-expanded={item.expanded}>
          <Icon name={item.icon} /><span>{item.label}</span>
        </button>)}
    <p ref={messageRef} className="ds-action-menu__message type-small" role="status" tabIndex={-1}>{message ?? ''}</p>
    <button type="button" className="ds-action-menu__close type-label" onClick={onClose}>Close</button>
  </div>;
}
