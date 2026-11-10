import { Button } from './Button';
import { IconButton } from './IconButton';

/** The pet's motion on or off (add-pet › Pet motion rule, WCAG 2.2.2): «Pause motion» while it moves, «Play motion»
 *  while it stands — paused by the viewer, or by the system's reduced motion until the viewer plays it. The label
 *  names the action, so no aria-pressed. Enter and Space toggle (a native button); the focus stays on it. The choice
 *  itself — which browser storage, which tab — is web/src/pet/motion.ts. */
export function MotionToggle({ paused, onToggle, icon = false }: { paused: boolean; onToggle: () => void; icon?: boolean }) {
  const words = paused ? 'Play motion' : 'Pause motion';
  if (icon) return <IconButton variant="secondary" icon={paused ? 'play' : 'pause'} label={words} onClick={onToggle} />;
  return (
    <Button variant="secondary" size="compact" nowrap icon={paused ? 'play' : 'pause'} onClick={onToggle}>
      {words}
    </Button>
  );
}
