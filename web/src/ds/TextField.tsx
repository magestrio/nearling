import { useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Note } from './Note';
import { cx } from './util';

/** A labelled one-line field: the label above; the error, then the hint, under it — both tied to it. `hint` — one
 *  line or an array of lines. `labelledBy` — the id of what names it on the page instead of a label. `action` — its
 *  button. `labelIcon` — an icon before the label (the private instruction's lock); `aside` — beside the label, at its row's end
 *  (what the field makes, live: the skill's badge); `rows` — the lines of a `multiline` one (3 without it). Controlled with
 *  `onChange`; without it the field keeps its own text. */
export function TextField({
  label,
  placeholder,
  value,
  onChange,
  maxLength,
  error,
  hint,
  disabled,
  readOnly,
  multiline,
  rows,
  labelledBy,
  labelIcon,
  aside,
  count,
  action,
  mono,
  grow,
}: {
  label?: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  maxLength?: number;
  error?: string;
  hint?: string | string[];
  disabled?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  rows?: number;
  labelledBy?: string;
  labelIcon?: IconName;
  aside?: ReactNode;
  /** «n / limit» from limit − 10 (short fields) or − 100 (long ones), as the chat input's: the limit is shown before it is hit */
  count?: boolean;
  action?: ReactNode;
  /** an address or code: mono, no ligatures */
  mono?: boolean;
  /** a multiline field that grows with its text and never scrolls by itself (the sheet's body is the one scroll) */
  grow?: boolean;
}) {
  const id = useId();
  const [own, setOwn] = useState(value ?? '');
  const text = onChange ? (value ?? '') : own;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const described = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    className: cx('ds-field__input', multiline && 'ds-field__input--multiline', grow && 'ds-field__input--grow', 'type-body', mono && 'ds-field__input--mono'),
    value: text,
    placeholder,
    maxLength,
    disabled,
    readOnly,
    autoComplete: 'off',
    spellCheck: false,
    'aria-labelledby': labelledBy,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': described,
  };
  const set = (v: string) => (onChange ? onChange(v) : setOwn(v));
  const input = multiline ? (
    <textarea {...common} rows={rows ?? 3} onChange={(e) => set(e.target.value)} />
  ) : (
    <input {...common} type="text" onChange={(e) => set(e.target.value)} />
  );
  const labelNode = labelledBy ? null : (
    <label className="ds-field__label type-body-strong" htmlFor={id}>
      {labelIcon ? <Icon name={labelIcon} size="sm" /> : null}
      {label}
    </label>
  );
  return (
    <div className="ds-field">
      {aside ? <div className="ds-field__head">{labelNode}{aside}</div> : labelNode}
      {action ? <div className="ds-field__row">{input}{action}</div> : input}
      {count && maxLength && text.length >= maxLength - (maxLength >= 500 ? 100 : 10) ? (
        <span className="ds-field__count type-caption" aria-live="polite">
          {text.length} / {maxLength}
        </span>
      ) : null}
      {error ? (
        <Note id={errorId} tone="error">
          {error}
        </Note>
      ) : null}
      {Array.isArray(hint) ? (
        <div id={hintId} className="ds-field__hints">
          {hint.map((line, i) => (
            <Note key={i}>{line}</Note>
          ))}
        </div>
      ) : hint ? (
        <Note id={hintId}>{hint}</Note>
      ) : null}
    </div>
  );
}
