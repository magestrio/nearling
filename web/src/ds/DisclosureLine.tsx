import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function DisclosureLine({ summary, label, children, open: initiallyOpen = false }: {
  summary: string; label: string; children?: ReactNode; open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  return <div className="ds-disclosure-line">
    <p className="ds-disclosure-line__summary type-small">{summary}{' '}
      <button type="button" className="ds-disclosure-line__toggle type-small" aria-expanded={open} aria-controls={id} onClick={() => setOpen((now) => !now)}>
        {open ? 'Hide details' : label}<Icon name="chevron" size="sm" />
      </button>
    </p>
    {open ? <div className="ds-disclosure-line__body type-small" id={id}>{children}</div> : null}
  </div>;
}
