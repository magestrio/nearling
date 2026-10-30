import { lazy, Suspense, useEffect } from 'react';
import { go, parseRoute, useLocation } from './route';
import { HatchScreen } from './screens/hatch/HatchScreen';
import { PetNotFound, PetScreen } from './screens/pet/PetScreen';
import { ReturnToPlace } from './signin/ReturnToPlace';

// The day-1 route exists in dev builds only: with VITE_DEV_ROUTE not 'true' the branch is dead code and the
// chunk is never emitted.
const Day1Page = import.meta.env.VITE_DEV_ROUTE === 'true' ? lazy(() => import('./day1/Day1Page')) : null;

/** A link inside the app is followed without a page load: the screen's state (a typed name) is the tab's memory. */
function useInternalLinks() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.target || link.origin !== window.location.origin) return;
      if (parseRoute(link.pathname + link.search).name === 'unknown') return;
      e.preventDefault();
      go(link.pathname + link.search);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

export function App() {
  const route = parseRoute(useLocation());
  useInternalLinks();
  return (
    <>
      <ReturnToPlace />
      {route.name === 'hatch' ? <HatchScreen from={route.from} /> : null}
      {route.name === 'pet' ? <PetScreen key={route.tokenId} tokenId={route.tokenId} from={route.from} /> : null}
      {route.name === 'pet-broken' ? <PetNotFound /> : null}
      {Day1Page && route.name === 'day1' ? (
        <Suspense fallback={null}>
          <Day1Page />
        </Suspense>
      ) : null}
    </>
  );
}
