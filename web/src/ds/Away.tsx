// DS 0.29 · design/ds/components.js › Away.

/** The pet away on an errand: the stage empty but for its light pool, a dotted path from it to «?» and a dot walking it while the
 *  pet is out. Decorative (`aria-hidden`): the conversation's last line says it. `paused` — «Pause motion» stops the walker, as it
 *  stops the pet's idle loop; under `prefers-reduced-motion` the CSS keeps it still. */
export function Away({ paused }: { paused?: boolean }) {
  return (
    <div className="ds-away" aria-hidden="true">
      <span className="ds-away__path">
        <span className="ds-away__walker" style={paused ? { animationPlayState: 'paused' } : undefined} />
      </span>
      <span className="ds-away__mark type-title-3">?</span>
      <span className="ds-away__pool" />
    </div>
  );
}
