import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Note, PetList, PetRow, Sheet, Stack, Button, Cluster } from '../ds';
import { go, petPath } from '../route';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type PetView } from '../seams/worker';
import { registerAction } from '../screens/pet/parts';

let openFor: string | null = null;
const listeners = new Set<() => void>();
const publish = (tokenId: string | null) => { openFor = tokenId; for (const listener of listeners) listener(); };
export const closeMyPets = () => publish(null);
export const useMyPetsOpen = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => openFor, () => null);
registerAction('myPets', ({ tokenId }) => publish(tokenId));

type Row = { tokenId: string; name: string; stage: PetView['stage']; fullness: PetView['fullness'] };
type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; rows: Row[] };

export function MyPetsSheet({ tokenId }: { tokenId: string }) {
  const auth = useAuth();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const read = useCallback(async () => {
    try {
      const token = await auth.getIdentityToken();
      if (token === null) throw new WorkerError(401, 'signed_out');
      const list = await workerApi.myPets(token);
      // Public reads supply fullness and the figure without changing the server's current-pet choice.
      const views = await Promise.all(list.pets.map((pet) => workerApi.pet(null, pet.tokenId)));
      setLoad({ kind: 'ready', rows: list.pets.map((pet, index) => ({ tokenId: pet.tokenId, name: pet.name, stage: views[index]!.stage, fullness: views[index]!.fullness })) });
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) { auth.endSession(true); closeMyPets(); }
      else setLoad({ kind: 'error' });
    }
  }, [auth]);
  useEffect(() => { void read(); }, [read, attempt]);
  const select = (id: string) => { closeMyPets(); go(petPath(id)); };
  return <Sheet title="Your pets" popover onClose={closeMyPets}>
    {load.kind === 'ready' ? <PetList label="Your pets">
      {load.rows.map((row) => <PetRow key={row.tokenId} {...row} current={row.tokenId === tokenId} onSelect={() => select(row.tokenId)} />)}
    </PetList> : load.kind === 'error' ? <Stack gap={3}>
      <Note tone="error">We couldn't load your pets right now. Try again in a moment.</Note>
      <Cluster><Button variant="secondary" size="compact" onClick={() => { setLoad({ kind: 'loading' }); setAttempt((value) => value + 1); }}>Try again</Button></Cluster>
    </Stack> : null}
  </Sheet>;
}
