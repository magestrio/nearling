import { Hono } from 'hono';
import { tick } from './cron';
import { gate, type AppEnv } from './http';
import { hatchRoutes } from './routes/hatch';
import { petRoutes } from './routes/pets';
import { thoughtRoutes } from './routes/thoughts';

const app = new Hono<AppEnv>();

// The smoke of every deploy reads this: `version` is the id of the Worker version that answered.
app.get('/health', (c) =>
  c.json({
    ok: true,
    version: c.env.CF_VERSION_METADATA.id,
    env: c.env.ENVIRONMENT,
  }),
);

// Every /api route: the request limit first, then the session (src/http.ts).
app.use('/api/*', gate);
app.route('/', petRoutes);
app.route('/', thoughtRoutes);
app.route('/', hatchRoutes);

// The cron (`triggers.crons`, every minute): sessions to debit, the diary, the pause of the services.
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(tick(env));
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;

export { Limiter } from './do/limiter';
export { GuestView } from './do/guestView';
export { ServerKey } from './do/serverKey';
export { PetDesk } from './pet/desk';
