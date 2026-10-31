import { Button } from './Button';
import { cx } from './util';

/** A value to copy (an address, a link) and its «Copy» at the right; `mono` — for an address. The value wraps, never
 *  cut, and can be selected by hand. `onCopy` is the build's: what a copy does and its Toast are the screen's. */
export function CopyField({ value, mono, copyLabel, onCopy }: { value: string; mono?: boolean; copyLabel?: string; onCopy?: () => void }) {
  return (
    <div className="ds-copy">
      <span className={cx('ds-copy__value', mono ? 'type-mono' : 'type-body')}>{value}</span>
      <Button variant="secondary" size="compact" icon="copy" onClick={onCopy}>
        {copyLabel ?? 'Copy'}
      </Button>
    </div>
  );
}
