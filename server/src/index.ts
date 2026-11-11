import { Hono } from 'hono';
import { tick } from './cron';
import { gate, type AppEnv } from './http';
import { catalogRoutes } from './routes/catalog';
import { codeRoutes } from './routes/code';
import { debateRoutes } from './routes/debates';
import { diaryRoutes } from './routes/diary';
import { errandRoutes } from './routes/errands';
import { experienceRoutes } from './routes/experience';
import { feedingRoutes } from './routes/feeding';
import { giftRoutes } from './routes/gift';
import { hatchRoutes } from './routes/hatch';
import { hireRoutes } from './routes/hire';
import { memoryRoutes } from './routes/memory';
import { petRoutes } from './routes/pets';
import { exchangeRoutes, sessionRoutes } from './routes/session';
import { showcaseRoutes } from './routes/showcase';
import { showcaseCardRoutes } from './routes/showcaseCard';
import { societyRoutes } from './routes/society';
import { sourceRoutes } from './routes/sources';
import { thoughtRoutes } from './routes/thoughts';
import { wardrobeRoutes } from './routes/wardrobe';
import { verificationRoutes } from './routes/verification';
import { workRoutes } from './routes/work';
import { watchRoutes } from './routes/watch';
import { willRoutes } from './routes/will';

const app = new Hono<AppEnv>();

// The smoke of every deploy reads this: `version` is the id of the Worker version that answered.
app.get('/health', (c) =>
  c.json({
    ok: true,
    version: c.env.CF_VERSION_METADATA.id,
    env: c.env.ENVIRONMENT,
  }),
);

// The exchange after Google stands outside the gate: it makes the player's row (routes/session.ts).
app.route('/', exchangeRoutes);

// Every other /api route: the request limit first, then the session (src/http.ts).
app.use('/api/*', gate);
app.route('/', sessionRoutes);
app.route('/', showcaseRoutes);
app.route('/', showcaseCardRoutes);
app.route('/', petRoutes);
app.route('/', societyRoutes);
app.route('/', thoughtRoutes);
app.route('/', memoryRoutes);
app.route('/', diaryRoutes);
app.route('/', hatchRoutes);
app.route('/', hireRoutes);
app.route('/', feedingRoutes);
app.route('/', giftRoutes);
app.route('/', wardrobeRoutes);
app.route('/', workRoutes);
app.route('/', watchRoutes);
app.route('/', errandRoutes);
app.route('/', experienceRoutes);
app.route('/', sourceRoutes);
app.route('/', catalogRoutes);
app.route('/', codeRoutes);
app.route('/', debateRoutes);
app.route('/', verificationRoutes);
app.route('/', willRoutes);

// The cron (`triggers.crons`, every minute): sessions to debit, the diary, the pause of the services.
async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(tick(env));
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;

export { Limiter } from './do/limiter';
export { GuestView } from './do/guestView';
export { Showcase } from './do/showcase';
export { ServerKey } from './do/serverKey';
export { SourceCache } from './do/sourceCache';
export { PetDesk } from './pet/desk';
