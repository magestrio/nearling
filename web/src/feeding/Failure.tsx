import type { ReactNode } from 'react';
import { Button, Cluster, Note } from '../ds';

/** What did not work and «Try again» beside it, at the top of a sheet's body (placement). */
export function Failure({ id, onRetry, children }: { id?: string; onRetry: () => void; children: ReactNode }) {
  return (
    <Cluster gap={3} justify="space-between">
      <Note tone="error" id={id}>
        {children}
      </Note>
      <Button variant="secondary" size="compact" onClick={onRetry}>
        Try again
      </Button>
    </Cluster>
  );
}
