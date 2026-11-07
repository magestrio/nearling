import { lazy, Suspense, useEffect } from 'react';
import { Button, Center, Heading, Live, Page, Shell } from './ds';
import { go, parseRoute, useLocation } from './route';
import './account/register';
import { ClearMemoryLayer } from './account/ClearMemoryLayer';
import './feeding/register';
import './life/register';
import { CatalogPage } from './adapters/CatalogPage';
import { useAuth } from './seams/auth';
import { HatchScreen } from './screens/hatch/HatchScreen';
import { HomeScreen } from './screens/home/HomeScreen';
import { PetNotFound, PetScreen } from './screens/pet/PetScreen';
import { GiftPage } from './gift/GiftPage';
import { HireBoardPage } from './work/HireBoardPage';
import { VerificationPage } from './verification/VerificationPage';
import { SocietyPage } from './society/SocietyPage';
import { ReturnToPlace } from './signin/ReturnToPlace';
import { SharedErrandPage } from './errands/SharedErrandPage';
import { SignInLayer } from './signin/signIn';

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

const UNREACHABLE = "We can't reach the game right now. Try again in a moment.";

/** `Connection rule` › «сервер недоступен» with nothing to show: the exchange that opens the session got no answer. The place
 *  stays in the tab until it has answered (Home draws its own `home-error`). */
function ConnectionPage({ tryAgain }: { tryAgain: () => void }) {
  return (
    <Shell fill>
      <Page fill width="narrow">
        <Center>
          <Heading level={1} variant="title-2" align="center">
            {UNREACHABLE}
          </Heading>
          <Button onClick={tryAgain}>Try again</Button>
        </Center>
      </Page>
    </Shell>
  );
}

export function App() {
  const route = parseRoute(useLocation());
  const auth = useAuth();
  useInternalLinks();
  const unreachable = auth.unreachable && route.name !== 'home' && route.name !== 'day1';
  return (
    <SignInLayer>
      <ClearMemoryLayer>
        <ReturnToPlace />
        <Live>{unreachable ? UNREACHABLE : ''}</Live>
        {unreachable ? <ConnectionPage tryAgain={auth.retrySession} /> : null}
        {/* Home draws its own `Connection rule` page (`home-error`), whatever the exchange answered */}
        {route.name === 'home' ? <HomeScreen /> : null}
        {!unreachable && route.name === 'hire' ? <HireBoardPage /> : null}
        {!unreachable && route.name === 'relationships' ? <SocietyPage key={route.tokenId} tokenId={route.tokenId} /> : null}
        {!unreachable && route.name === 'hatch' ? <HatchScreen from={route.from} /> : null}
        {!unreachable && route.name === 'gift' ? <GiftPage key={route.code} code={route.code} /> : null}
        {!unreachable && route.name === 'verify' ? <VerificationPage key={route.tokenId} tokenId={route.tokenId} thoughtId={route.thoughtId} /> : null}
        {!unreachable && route.name === 'receipt' ? <VerificationPage key={route.code} code={route.code} /> : null}
        {!unreachable && route.name === 'shared-errand' ? <SharedErrandPage key={route.code} tokenId={route.tokenId} code={route.code} /> : null}
        {/* one element for the three: the Diary and the Wardrobe open over the Pet screen's own state (the pet, the poll, the line being typed) */}
        {!unreachable && (route.name === 'pet' || route.name === 'diary' || route.name === 'wardrobe' || route.name === 'experience' || route.name === 'work-record') ? (
          <PetScreen
            key={route.tokenId}
            tokenId={route.tokenId}
            from={route.name === 'pet' ? route.from : null}
            diary={route.name === 'diary'}
            wardrobe={route.name === 'wardrobe'}
            experience={route.name === 'experience'}
            workRecord={route.name === 'work-record'}
          />
        ) : null}
        {!unreachable && route.name === 'pet-broken' ? <PetNotFound /> : null}
        {!unreachable && route.name === 'adapters' ? <CatalogPage key={route.pet ?? ''} pet={route.pet} /> : null}
        {Day1Page && route.name === 'day1' ? (
          <Suspense fallback={null}>
            <Day1Page />
          </Suspense>
        ) : null}
      </ClearMemoryLayer>
    </SignInLayer>
  );
}
