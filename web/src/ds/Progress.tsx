import type { CSSProperties, ReactNode } from 'react';

// DS 0.46 · design/ds/components.js › Progress; its track is a picture and the words carry the amount.
export function Progress({ value, children }: { value: number; children: ReactNode }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return <div className="ds-progress">
    <span className="ds-progress__track" aria-hidden="true"><span className="ds-progress__fill" style={{ '--progress': v } as CSSProperties} /></span>
    <p className="ds-progress__words type-lead">{children}</p>
  </div>;
}
