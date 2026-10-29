import { lazy, Suspense, useEffect } from 'react';
import { takeReturnPlace } from './day1/returnPlace';
import { navigate, usePath } from './route';
import { useAuth } from './seams/auth';

// The day-1 route exists in dev builds only: with VITE_DEV_ROUTE not 'true' the branch is dead code and the
// chunk is never emitted.
const Day1Page = import.meta.env.VITE_DEV_ROUTE === 'true' ? lazy(() => import('./day1/Day1Page')) : null;

/** After Google sign-in Privy lands on `/`; the tab goes back to where the sign-in began. */
function ReturnToPlace() {
  const auth = useAuth();
  useEffect(() => {
    if (!auth.ready || !auth.authenticated || window.location.pathname !== '/') return;
    const place = takeReturnPlace();
    if (place) navigate(place);
  }, [auth.ready, auth.authenticated]);
  return null;
}

export function App() {
  const path = usePath();
  return (
    <>
      {Day1Page && <ReturnToPlace />}
      {Day1Page && path === '/__day1' ? (
        <Suspense fallback={null}>
          <Day1Page />
        </Suspense>
      ) : null}
    </>
  );
}
