import { createContext, useContext, useId, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Note } from './Note';
import { cx } from './util';

// DS 0.29 · design/ds/components.js › Sockets, Socket.
const OffNote = createContext<string | undefined>(undefined);

/** A skill's outside parts on Skill sheet: three round sockets for data sources, a square one for code, in one row. `note` — one
 *  line under them, why they are off (each disabled socket names it in its description). */
export function Sockets({ note, children }: { note?: string; children?: ReactNode }) {
  const noteId = useId();
  return (
    <div className="ds-sockets">
      <OffNote.Provider value={note ? noteId : undefined}>
        <ul className="ds-sockets__list">{children}</ul>
      </OffNote.Provider>
      {note ? <Note id={noteId}>{note}</Note> : null}
    </div>
  );
}

/** `kind`: data | code. `label` — what fills it (a source's name, «{name}'s code»); `empty` — its action when nothing does («Connect
 *  data», «Add code»), drawn with a plus; `note` — a caption under a filled one. A button that opens its sheet: Tab in order, Enter. */
export function Socket({
  kind = 'data',
  label,
  empty,
  note,
  disabled,
  onClick,
  expanded,
}: {
  kind?: 'data' | 'code';
  label?: string;
  empty?: string;
  note?: string;
  disabled?: boolean;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const noteId = useId();
  const offNote = useContext(OffNote);
  const described = [note ? noteId : null, disabled ? offNote : null].filter(Boolean).join(' ') || undefined;
  return (
    <li className="ds-sockets__item">
      <button
        type="button"
        className={cx('ds-socket', `ds-socket--${kind}`, !label && 'ds-socket--empty')}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-describedby={described}
        onClick={onClick}
      >
        <span className="ds-socket__disc">
          <Icon name={!label ? 'plus' : kind === 'code' ? 'code' : 'globe'} />
        </span>
        <span className="ds-socket__label type-small">{label || empty}</span>
      </button>
      {note ? (
        <p className="ds-socket__note type-caption" id={noteId}>
          {note}
        </p>
      ) : null}
    </li>
  );
}
