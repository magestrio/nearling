// `POST /api/pets/:id/memory/clear`: the owner erases the pet's memory (Memory deletion data). The
// owner is read from the contract on this request, without a cache (`ownedPet`); the erasing is one
// D1 batch, whole or nothing. It spends nothing and writes nothing to the network, so a sleeping pet
// and a pause of the services do not stop it.
import { Hono } from 'hono';
import type { AppEnv } from '../http';
import { forgetStatements } from '../pet/forget';
import { ownedPet } from './thoughts';

export const memoryRoutes = new Hono<AppEnv>();

memoryRoutes.post('/api/pets/:id/memory/clear', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  try {
    await c.env.DB.batch(forgetStatements(c.env.DB, owned.id, Date.now()));
  } catch {
    // The batch is one transaction: nothing was erased.
    console.log('clear_failed');
    return c.json({ code: 'clear_failed' }, 500);
  }
  console.log('memory_cleared');
  return c.json({ ok: true });
});
