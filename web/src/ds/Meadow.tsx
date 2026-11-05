import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { canUseWebGL, drawFlat } from '../pet/flat';
import { MeadowScene, type MeadowPet } from '../pet/MeadowScene';
import { stillOf } from '../pet/meadowStills';
import { FigureBoundary } from '../pet/PetFigure';
import { useMotionPaused } from '../pet/motion';
import { Icon } from './Icon';
import { MotionToggle } from './MotionToggle';
import { Only } from './layout';
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
  return <canvas ref={ref} className="ds-pet ds-pet--fill ds-meadow__flat" style={{ width: '100%', height: '100%' }} />;
}

export type MeadowVisit = MeadowPet & { href?: string; name?: string; tag?: string; tagged?: boolean };
export type MeadowNumber = { value: string; label: string };

/** DS 0.44: one scene, linked pets in reading order, and the contract's public numbers. */
export function Meadow({ pets, motion = true, numbers, explore, label }: {
  pets: MeadowVisit[]; motion?: boolean | ReactNode; numbers?: MeadowNumber[] | 'loading'; explore?: ReactNode; label?: string;
}) {
  const ground = useRef<HTMLDivElement>(null);
  const targets = useRef<Array<HTMLDivElement | null>>([]);
  const positions = useRef<Record<number, number>>({});
  const [size, setSize] = useState({ width: 0, height: 0, rem: 16 });
  const [lost, setLost] = useState(() => !canUseWebGL());
  const [onScreen, setOnScreen] = useState(true);
  const [paused, toggle] = useMotionPaused();
  const ordered = [...pets].sort((a, b) => a.x - b.x);
  const live = ordered.some((pet) => Boolean(pet.href));
  const loading = numbers === 'loading';
  const stats = loading ? [{ value: '0', label: 'pets' }, { value: '0', label: 'thoughts' }, { value: '0', label: 'NEAR' }] : numbers;
  const moveTarget = useCallback((index: number, x: number) => {
    positions.current[index] = x;
    targets.current[index]?.style.setProperty('--x', String(x));
  }, []);
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
      <div className="ds-meadow__ground" aria-hidden={live ? undefined : true} role={live ? 'list' : undefined} aria-label={live ? label : undefined} data-illustration="" ref={ground}>
        {size.width > 0 && size.height > 0 && !lost ? (
          <FigureBoundary onFail={() => setLost(true)}>
            <MeadowScene pets={ordered} {...size} paused={paused || !onScreen} onLost={() => setLost(true)} onMove={moveTarget} />
          </FigureBoundary>
        ) : null}
        {ordered.map((pet, index) => (
          <div
            key={pet.href ?? index}
            ref={(node) => { targets.current[index] = node; }}
            role={pet.href ? 'listitem' : undefined}
            className={cx('ds-meadow__pet', `ds-meadow__pet--${pet.stage}`, `ds-meadow__pet--${pet.state}`, pet.flip && 'ds-meadow__pet--flip', pet.wide && 'ds-meadow__pet--wide', pet.tagged && 'ds-meadow__pet--tagged')}
            style={{ '--x': positions.current[index] ?? pet.x, '--depth': pet.depth, zIndex: pet.tagged ? 11 : Math.round(pet.depth * 10), aspectRatio: stillOf(pet).aspect } as CSSProperties}
          >
            {pet.href ? <a className="ds-meadow__link" href={pet.href} aria-label={pet.tag}>
              {lost ? <FlatSample pet={pet} /> : null}
              {pet.state === 'asleep' ? <span className="ds-meadow__zz" aria-hidden="true"><Icon name="sleep" size="sm" /><Icon name="sleep" size="sm" /></span> : null}
              {pet.tag ? <span className="ds-meadow__tag type-small" aria-hidden="true"><span className="ds-meadow__tag-name">{pet.name}</span>{pet.tag.slice(pet.name?.length ?? 0)}</span> : null}
            </a> : <>
              {lost ? <FlatSample pet={pet} /> : null}
              {pet.state === 'asleep' ? <span className="ds-meadow__zz"><Icon name="sleep" size="sm" /><Icon name="sleep" size="sm" /></span> : null}
            </>}
          </div>
        ))}
      </div>
      {stats || explore || (motion && pets.length > 0 && !lost) ? <div className={cx('ds-meadow__foot', Boolean(stats || explore) && 'ds-meadow__foot--numbers')}>
        {stats ? <ul className={cx('ds-meadow__stats', loading && 'ds-meadow__stats--loading')} aria-hidden={loading ? true : undefined}>
          {stats.map((n, i) => <li key={i} className="ds-meadow__stat"><span className="ds-meadow__value type-title-2">{n.value}</span>{' '}<span className="ds-meadow__label type-small">{n.label}</span></li>)}
        </ul> : null}
        {explore ? <div className="ds-meadow__explore">{explore}</div> : null}
        {motion && pets.length > 0 && !lost ? <div className="ds-meadow__motion">{motion === true ? <><Only on="desktop"><MotionToggle paused={paused} onToggle={toggle} /></Only><Only on="phone"><MotionToggle paused={paused} onToggle={toggle} icon /></Only></> : motion}</div> : null}
      </div> : null}
    </div>
  );
}
