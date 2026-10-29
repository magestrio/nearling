import { fakeState } from './fakes';
import type { WorkerApi } from './worker';

export const fakeWorkerApi: WorkerApi = {
  async health() {
    return { ok: true, version: fakeState().worker?.version ?? 'fake-version', env: 'e2e' };
  },
};
