import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { canUseWebGL, drawFlat } from '../pet/flat';
import { MeadowScene, type MeadowPet } from '../pet/MeadowScene';
import { FigureBoundary } from '../pet/PetFigure';
import { useMotionPaused } from '../pet/motion';
import { Icon } from './Icon';
import { MotionToggle } from './MotionToggle';
import { cx } from './util';

function FlatSample({ pet }: { pet: MeadowPet }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      drawFlat(canvas, { tokenId: String(pet.seed), stage: pet.stage, state: pet.state, outfit: pet.outfit ?? 'none' });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [pet]);
  return <canvas ref={ref} className="ds-pet ds-pet--fill ds-meadow__flat" />;
}

/** DS 0.39 Meadow: the sample pets are decoration; the motion control follows the same choice as every pet screen. */
export function Meadow({ pets, motion = true }: { pets: MeadowPet[]; motion?: boolean | ReactNode }) {
  const ground = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, rem: 16 });
  const [lost, setLost] = useState(() => !canUseWebGL());
  const [onScreen, setOnScreen] = useState(true);
  const [paused, toggle] = useMotionPaused();
  useLayoutEffect(() => {
    const element = ground.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setSize({ width: box.width, height: box.height, rem });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = ground.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(Boolean(entry?.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={cx('ds-meadow', (paused || lost) && 'ds-meadow--paused')}>
      <div className="ds-meadow__ground" aria-hidden="true" data-illustration="" ref={ground}>
        {size.width > 0 && size.height > 0 && !lost ? (
          <FigureBoundary onFail={() => setLost(true)}>
            <MeadowScene pets={pets} {...size} paused={paused || !onScreen} onLost={() => setLost(true)} />
          </FigureBoundary>
        ) : null}
        {pets.map((pet, index) => (
          <div
            key={index}
            className={cx('ds-meadow__pet', `ds-meadow__pet--${pet.stage}`, `ds-meadow__pet--${pet.state}`, pet.flip && 'ds-meadow__pet--flip', pet.wide && 'ds-meadow__pet--wide')}
            style={{ '--x': pet.x, '--depth': pet.depth, zIndex: Math.round(pet.depth * 10) } as CSSProperties}
          >
            {lost ? <FlatSample pet={pet} /> : null}
            {pet.state === 'asleep' ? <span className="ds-meadow__zz"><Icon name="sleep" size="sm" /><Icon name="sleep" size="sm" /></span> : null}
          </div>
        ))}
      </div>
      {motion && !lost ? (
        <div className="ds-meadow__motion">{motion === true ? <MotionToggle paused={paused} onToggle={toggle} /> : motion}</div>
      ) : null}
    </div>
  );
}
