import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './util';

/** The input of the conversation: Enter sends, Shift+Enter breaks a line, Enter while composing (an IME) does
 *  nothing; the count «n / limit» shows from limit − 100, counted in code points as the server counts. `disabled` is
 *  the DS's «off»: read-only and aria-disabled, never `disabled`, so a focus in it stays and the typed text stays.
 *  `start` / `end` hold its buttons, `note` — a Note about why something is off, tied to the field. Controlled with
 *  `onChange`; without it the field keeps its own text. */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  label,
  disabled,
  note,
  start,
  end,
  limit = 500,
  autoFocus,
}: {
  value?: string;
  onChange?: (value: string) => void;
  onSend?: (text: string) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  note?: ReactNode;
  start?: ReactNode;
  end?: ReactNode;
  limit?: number;
  autoFocus?: boolean;
}) {
  const noteId = useId();
  const [own, setOwn] = useState(value ?? '');
  const text = onChange ? (value ?? '') : own;
  const length = [...text].length;
  const set = (v: string) => {
    const next = [...v].length > limit ? [...v].slice(0, limit).join('') : v;
    if (onChange) onChange(next);
    else setOwn(next);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // an off field (asleep, tired, paused) is read-only: Enter sends nothing, the text waits
      if (onSend && text.trim() && !disabled) onSend(text);
    }
  };
  return (
    <form className={cx('ds-composer', disabled && 'ds-composer--disabled')} onSubmit={(e) => e.preventDefault()}>
      <textarea
        className="ds-composer__field type-body"
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        readOnly={disabled}
        aria-disabled={disabled || undefined}
        autoFocus={autoFocus}
        aria-describedby={note ? noteId : undefined}
        onChange={(e) => set(e.target.value)}
        onKeyDown={onKey}
      />
      {note ? (
        <div id={noteId} className="ds-composer__note">
          {note}
        </div>
      ) : null}
      <div className="ds-composer__bar">
        {start ? <div className="ds-composer__start">{start}</div> : null}
        <div className="ds-composer__end">
          {length >= limit - 100 ? (
            <span className="ds-composer__count type-caption" aria-live="polite">
              {length} / {limit}
            </span>
          ) : null}
          {end}
        </div>
      </div>
    </form>
  );
}
