import type { ReactNode } from 'react';
import { Dock } from '../ds';

/** The advice composer belongs to the Stage chat column on both viewports. */
export function AdviceDock({ children }: { children: ReactNode }) {
  return <Dock>{children}</Dock>;
}
