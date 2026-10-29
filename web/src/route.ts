import { useSyncExternalStore } from 'react';

const EVENT = 'nearling:navigate';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** The current path. The client has few routes; a router library is not worth a dependency yet. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(path: string): void {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new Event(EVENT));
}
