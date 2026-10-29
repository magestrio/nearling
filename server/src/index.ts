import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

// The smoke of every deploy reads this: `version` is the id of the Worker version that answered.
app.get('/health', (c) =>
  c.json({
    ok: true,
    version: c.env.CF_VERSION_METADATA.id,
    env: c.env.ENVIRONMENT,
  }),
);

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
