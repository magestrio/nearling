import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Dock } from '../ds';
import './advice.css';

/** The fixed phone composer reserves exactly its visible height in the scrolling page. */
export function AdviceDock({ children }: { children: ReactNode }) {
  const space = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!dock.current || !space.current) return;
    const element = dock.current;
    const spacer = space.current;
    const measure = () => { spacer.style.height = `${element.getBoundingClientRect().height}px`; };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return <>
    <div ref={space} className="advice-phone-dock-space" aria-hidden="true" />
    <div ref={dock} className="advice-dock-wrap"><Dock>{children}</Dock></div>
  </>;
}
