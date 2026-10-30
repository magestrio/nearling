import { Button } from './Button';

/** The pet's motion on or off (add-pet › Pet motion rule, WCAG 2.2.2): «Pause motion» while it moves, «Play motion»
 *  while it stands — paused by the viewer, or by the system's reduced motion until the viewer plays it. The label
 *  names the action, so no aria-pressed. Enter and Space toggle (a native button); the focus stays on it. The choice
 *  itself — which browser storage, which tab — is web/src/pet/motion.ts. */
export function MotionToggle({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <Button variant="secondary" size="compact" icon={paused ? 'play' : 'pause'} onClick={onToggle}>
      {paused ? 'Play motion' : 'Pause motion'}
    </Button>
  );
}
