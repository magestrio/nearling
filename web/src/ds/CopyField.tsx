import { Button } from './Button';
import { cx } from './util';
import type { Ref } from 'react';

/** A value to copy (an address, a link) and its «Copy» at the right; `mono` — for an address. The value wraps, never
 *  cut, and can be selected by hand. `onCopy` is the build's: what a copy does and its Toast are the screen's. */
export function CopyField({ value, mono, copyLabel, onCopy, label = 'Value to copy', inputRef }: {
  value: string; mono?: boolean; copyLabel?: string; onCopy?: () => void; label?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <div className="ds-copy">
      <textarea ref={inputRef} className={cx('ds-copy__value', mono ? 'type-mono' : 'type-body')}
        aria-label={label} readOnly rows={1} value={value} />
      <Button variant="secondary" size="compact" icon="copy" onClick={onCopy}>
        {copyLabel ?? 'Copy'}
      </Button>
    </div>
  );
}
