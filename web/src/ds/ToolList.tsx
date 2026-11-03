import { useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useReveal } from './reveal';
import { cx } from './util';

// DS 0.29 · design/ds/components.js › ToolList, ToolRow.

/** An adapter's tools after its test call, and the skill code's functions after a test run: a list of checkbox rows. `reveal` —
 *  the list was just made: its sheet's body scrolls it into view. */
export function ToolList({ label, reveal, children }: { label?: string; reveal?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  useReveal(ref, reveal);
  return (
    <ul className="ds-tools" aria-label={label} ref={ref}>
      {children}
    </ul>
  );
}

/** One tool: its name in mono is the box's label and its only name; its description and parameters stand in grey under it, tied
 *  by `aria-describedby`. The checkbox covers the row, a drawn box shows its state. `disabled` with `note` — a tool that takes
 *  free text: its name grey, the box at the hairline, the note after the description, tied to the box. Tab to each box, Space
 *  ticks, an off row is skipped. */
export function ToolRow({
  name,
  description,
  note,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  description: string;
  note?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <li className={cx('ds-tool', disabled && 'ds-tool--off')}>
      <input
        className="ds-tool__check"
        type="checkbox"
        id={id}
        checked={Boolean(checked)}
        disabled={disabled}
        aria-describedby={`${id}-d`}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="ds-tool__box" aria-hidden="true">
        <Icon name="check" size="sm" />
      </span>
      <span className="ds-tool__label">
        <label className="type-mono" htmlFor={id}>
          {name}
        </label>
        <span className="type-small ds-tool__desc" id={`${id}-d`}>
          {description}
          {note ? <span className="ds-tool__note">{` ${note}`}</span> : null}
        </span>
      </span>
    </li>
  );
}
