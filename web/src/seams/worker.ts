// The only module that talks to the game's Worker.
export interface Health {
  ok: boolean;
  version: string;
  env: string;
}

export interface WorkerApi {
  health(): Promise<Health>;
}

const real: WorkerApi = {
  async health() {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`worker health ${res.status}`);
    return (await res.json()) as Health;
  },
};

export const workerApi: WorkerApi =
  import.meta.env.VITE_FAKES === 'true' ? (await import('./worker.fake')).fakeWorkerApi : real;
