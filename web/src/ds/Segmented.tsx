import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './util';

export interface SegmentedOption {
  value: string;
  label: ReactNode;
}

/** A choice that applies at once, as a radio group — the hiring mode «Auto» / «Ask me first». `role` gives the chosen option the
 *  meaning's hue (`trust`). Tab reaches the selected option; arrows move and pick; Space picks. Controlled with `onChange`, else it
 *  keeps its own value. */
export function Segmented({
  label,
  role,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  role?: string;
  value?: string;
  options: SegmentedOption[];
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [own, setOwn] = useState(value ?? options[0]!.value);
  const current = onChange ? value : own;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const pick = (v: string) => {
    if (onChange) onChange(v);
    else setOwn(v);
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const n = (i + step + options.length) % options.length;
    pick(options[n]!.value);
    refs.current[n]?.focus();
  };
  return (
    <div className="ds-segmented" role="radiogroup" aria-label={label} data-role={role}>
      {options.map((o, i) => {
        const on = o.value === current;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on ? 'true' : 'false'}
            tabIndex={on ? 0 : -1}
            className={cx('ds-segmented__option', 'type-label')}
            disabled={disabled}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => pick(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
