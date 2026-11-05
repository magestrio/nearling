import { Hono } from 'hono';
import type { AppEnv } from '../http';

export const showcaseRoutes = new Hono<AppEnv>();

showcaseRoutes.get('/api/showcase', async (c) => {
  const copy = await c.env.SHOWCASE.get(c.env.SHOWCASE.idFromName('public')).read();
  return c.json(copy ?? { pets: [], numbers: null });
});
