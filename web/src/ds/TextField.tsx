import { useId, useState, type ReactNode } from 'react';
import { Note } from './Note';
import { cx } from './util';

/** A labelled one-line field: the label above; the error, then the hint, under it — both tied to it. `hint` — one
 *  line or an array of lines. `labelledBy` — the id of what names it on the page instead of a label. `action` — its
 *  button. Controlled with `onChange`; without it the field keeps its own text. */
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
  labelledBy,
  action,
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
  labelledBy?: string;
  action?: ReactNode;
}) {
  const id = useId();
  const [own, setOwn] = useState(value ?? '');
  const text = onChange ? (value ?? '') : own;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const described = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    className: cx('ds-field__input', multiline && 'ds-field__input--multiline', 'type-body'),
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
    <textarea {...common} rows={3} onChange={(e) => set(e.target.value)} />
  ) : (
    <input {...common} type="text" onChange={(e) => set(e.target.value)} />
  );
  return (
    <div className="ds-field">
      {labelledBy ? null : (
        <label className="ds-field__label type-body-strong" htmlFor={id}>
          {label}
        </label>
      )}
      {action ? <div className="ds-field__row">{input}{action}</div> : input}
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
