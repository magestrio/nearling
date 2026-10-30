// The shared copy of what the network says, for answers without a session (Guest view data):
// a pet's record (the instance named `pet:<token_id>`) or the hatch state (the instance `hatch`),
// not older than 15 seconds, in memory only. It holds no conversation, memory or player data; the
// unbilled thoughts are subtracted from the food outside it, from D1, at every request.
import { DurableObject } from 'cloudflare:workers';
import { ChainUnreachable, hatchView, petView, type HatchRecord, type PetRecord } from '../chain';

export const GUEST_COPY_MS = 15_000;

export type Copy<T> = { ok: true; value: T } | { ok: false };

interface Held<T> {
  at: number;
  value: T;
}

export class GuestView extends DurableObject<Env> {
  private pet: Held<PetRecord | null> | null = null;
  private petRead: Promise<Held<PetRecord | null>> | null = null;
  private hatch: Held<HatchRecord> | null = null;
  private hatchRead: Promise<Held<HatchRecord>> | null = null;

  async readPet(tokenId: string): Promise<Copy<PetRecord | null>> {
    const now = Date.now();
    if (this.pet && now - this.pet.at < GUEST_COPY_MS) return { ok: true, value: this.pet.value };
    // One read serves every request that arrives while it runs.
    this.petRead ??= petView(this.env, tokenId).then((value) => ({ at: Date.now(), value }));
    try {
      this.pet = await this.petRead;
      return { ok: true, value: this.pet.value };
    } catch (e) {
      if (e instanceof ChainUnreachable) return { ok: false };
      throw e;
    } finally {
      this.petRead = null;
    }
  }

  /** Whether hatching is open depends on the day's count and the pool, which `hatch_view` returns
   * for any account; the server's own account is asked. */
  async readHatch(): Promise<Copy<HatchRecord>> {
    const now = Date.now();
    if (this.hatch && now - this.hatch.at < GUEST_COPY_MS) return { ok: true, value: this.hatch.value };
    this.hatchRead ??= hatchView(this.env, this.env.SERVER_ACCOUNT_ID).then((value) => ({ at: Date.now(), value }));
    try {
      this.hatch = await this.hatchRead;
      return { ok: true, value: this.hatch.value };
    } catch (e) {
      if (e instanceof ChainUnreachable) return { ok: false };
      throw e;
    } finally {
      this.hatchRead = null;
    }
  }
}
