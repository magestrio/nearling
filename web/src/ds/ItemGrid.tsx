import { useId, type ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './util';

/** The pet's wardrobe (Wardrobe screen): the items as tiles in a list, 2 across on the phone, 3 on the desktop, in the
 *  screen's order (own, earned not yet, to buy). `dense` — a line (`ItemNote`) stands right after a tile: it takes the row
 *  under that tile's row and the tiles after it fill the rest of that row, on either viewport. */
export function ItemGrid({ dense, children }: { dense?: boolean; children?: ReactNode }) {
  return <ul className={cx('ds-item-grid', dense && 'ds-item-grid--dense')}>{children}</ul>;
}

/** A line about one tile across the whole grid, under that tile's row (a purchase that didn't go through). */
export function ItemNote({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <li className="ds-item-note" id={id}>
      {children}
    </li>
  );
}

/** One item: its picture (decorative — its name says what it is), its name, its one action. `worn` — on the pet now: ringed
 *  by the selected outline, its action «Take off». `action` — «Wear», «Take off», «Buy» or «Try again» (the price after it);
 *  the button's name is its label and the item's name, unique in the list. `condition` — an earned item not earned yet: its
 *  condition in place of an action, its picture muted. `off`, `disabled` (nothing can have focused it: the wardrobe still
 *  opening), `pending` (`pendingLabel` «Buying…»), `why` — the id of the line that says why it is off or what went wrong. */
export function ItemTile({
  picture,
  name,
  worn,
  condition,
  action,
  price,
  off,
  disabled,
  pending,
  pendingLabel,
  busy,
  why,
  onClick,
}: {
  picture: string;
  name: string;
  worn?: boolean;
  condition?: string;
  action?: string;
  price?: string | null;
  off?: boolean;
  disabled?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  /** «Wear» / «Take off» is on its way: the button keeps its label and the focus and a repeat tap does nothing */
  busy?: boolean;
  why?: string;
  onClick?: () => void;
}) {
  const nameId = useId();
  return (
    <li className={cx('ds-item', worn && 'ds-item--worn', condition && 'ds-item--locked')}>
      <img className="ds-item__picture" src={picture} alt="" draggable={false} />
      <span className="ds-item__name type-body-strong" id={nameId}>
        {name}
      </span>
      <div className="ds-item__action">
        {condition ? (
          <span className="ds-item__condition type-small">{condition}</span>
        ) : (
          <Button variant="secondary" size="compact" block price={price} off={off} disabled={disabled} pending={pending} pendingLabel={pendingLabel} busy={busy} describedBy={why} nameWith={nameId} onClick={onClick}>
            {action}
          </Button>
        )}
      </div>
    </li>
  );
}
