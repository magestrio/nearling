import { expect, test, type Page } from '@playwright/test';
import type { CatalogEntryView, SourceView, ToolView } from '../src/seams/worker-types';
import { ASLEEP_PIXEL, BISCUIT, calls, openWith, OWNER, PIXEL, setWorker, SIGNED_IN } from './helpers';

// Adapter catalog (add-pet-errands › Adapter catalog screen, Catalog flow): `/adapters`, or `/adapters?pet=<token_id>` from a pet's Skill
// sheet — every published adapter with the pet it came from, «Connect to {name}'s skill» for the pet's owner, nothing to connect for
// anyone else. The fakes answer the list, the viewer's reads and the test call.
test.use({ timezoneId: 'Etc/GMT-2' });

const LABEL = 'opening lines';
const INSTRUCTION = 'Give one surprising opening line, then say in one sentence why it works.';
const DATE: ToolView['params'] = [
  { name: 'month', type: 'number', required: true },
  { name: 'day', type: 'number', required: true },
];
const entry = (id: string, name: string, address: string, petId: string, petName: string, tools: Array<[string, string]>, at: number): CatalogEntryView => ({
  id,
  name,
  address,
  tools: tools.map(([n, d]) => ({ name: n, description: d, params: DATE, tickable: true })),
  petId,
  petName,
  publishedAt: at,
});
const ENTRIES: CatalogEntryView[] = [
  entry('e1', 'Open-Meteo', 'https://mcp.open-meteo.example.com', '7', 'Sage', [['forecast', 'Hourly and daily weather for a place, up to 16 days ahead.'], ['air_quality', 'Air quality and pollen for a place.']], 3),
  entry('e2', 'Moon phases', 'https://moon.example.com/mcp', '1', 'Mochi', [['phase_on', "The moon's phase and how much of it is lit on a date."]], 2),
  entry('e3', 'Tide times', 'https://tides.example.com/mcp', '2', 'Biscuit', [['tides_at', 'High and low tide times for a harbour, today and the next 6 days.']], 1),
];
const TOOLS: ToolView[] = [
  { name: 'forecast', description: 'Hourly and daily weather for a place, up to 16 days ahead.', params: DATE, tickable: true, ticked: true },
  { name: 'air_quality', description: 'Air quality and pollen for a place.', params: DATE, tickable: true, ticked: true },
];
const source = (label: string): SourceView => ({ id: `s-${label}`, label, tools: TOOLS, published: false, catalogGone: false, gift: false });

const ME = { accountId: 'a'.repeat(64), hatched: null, currentPet: { tokenId: '9', name: 'Pixel' }, ownedCount: 1 };
const PIXEL_WITH_SKILL = { ...PIXEL, skill: { label: LABEL }, owner: {} };

/** Pixel's owner, its skill saved with `sources`, three entries in the catalog; `extra` over the Worker fake */
const ownerWorker = (sources: SourceView[] = [], extra: Record<string, unknown> = {}) => ({
  ...OWNER,
  me: ME,
  pets: { '9': PIXEL_WITH_SKILL, '2': BISCUIT },
  skill: { skill: { label: LABEL, instruction: INSTRUCTION }, sources },
  adapters: { entries: ENTRIES },
  ...extra,
});

const connectButtons = (page: Page) => page.getByRole('button', { name: /^Connect to Pixel's skill/ });
const connectSheet = (page: Page) => page.getByRole('dialog', { name: "Connect data to Pixel's skill" });
const skillSheet = (page: Page) => page.getByRole('dialog', { name: "Pixel's skill" });
const BROWSE_LINE = "To connect one, open your pet's skill and tap “Add data”.";
const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";

// spec: add-pet-errands › Adapter catalog screen › error
test('error: «We couldn\'t load the catalog. Try again in a moment.» and «Try again», which reads the catalog again', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker([], { adapters: { fail: { status: 503, code: 'unavailable' } } }) });
  await expect(page.getByText("We couldn't load the catalog. Try again in a moment.")).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Adapter catalog' })).toBeVisible();
  await setWorker(page, { adapters: { entries: ENTRIES } });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Open-Meteo' })).toBeVisible();
  await expect(page.getByText("We couldn't load the catalog.")).toHaveCount(0);
});

// spec: add-pet-errands › Adapter catalog screen › success
test('success: every entry with its address, the pet it came from and its tools, each with «Connect to Pixel\'s skill»; «Back to Pixel» in the header', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker() });
  const list = page.getByRole('list', { name: 'Adapters' });
  await expect(list.getByRole('heading', { level: 2 })).toHaveText(['Open-Meteo', 'Moon phases', 'Tide times']);
  await expect(list.getByText('from Sage')).toBeVisible();
  await expect(list.getByText('https://moon.example.com/mcp')).toBeVisible();
  await expect(list.getByText("The moon's phase and how much of it is lit on a date.")).toBeVisible();
  await expect(connectButtons(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: "Connect to Pixel's skill Open-Meteo" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toHaveAttribute('href', '/pet/9');
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(page.getByText(BROWSE_LINE)).toHaveCount(0);
  await expect(page.getByText('A skill holds up to 3 data sources.')).toHaveCount(0);
});

// spec: add-pet-errands › Adapter catalog screen › success
test('success: «Back to Pixel» leads to Pixel\'s page with Skill sheet open', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker() });
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(skillSheet(page)).toBeVisible();
  await expect(skillSheet(page).getByLabel('What is Pixel good at?')).toHaveValue(LABEL);
});

// spec: add-pet-errands › Adapter catalog screen › success × the skill holds 3 sources
test('success × the skill holds 3 sources: every «Connect» is off and the line says why', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker([source('A'), source('B'), source('C')]) });
  await expect(page.getByText('A skill holds up to 3 data sources. Remove one to add another.')).toBeVisible();
  const buttons = connectButtons(page);
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) {
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription('A skill holds up to 3 data sources. Remove one to add another.');
  }
  await buttons.first().click({ force: true });
  await expect(connectSheet(page)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.includes('checkSource'))).toEqual([]);
});

// spec: add-pet-errands › Catalog flow › connect from the catalog
test('connect from the catalog: Adapter sheet with the entry\'s name and address, its test call made, the tools ticked', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker([], { checkSource: { tools: TOOLS } }) });
  await page.getByRole('button', { name: "Connect to Pixel's skill Open-Meteo" }).click();
  const dialog = connectSheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Name it')).toHaveValue('Open-Meteo');
  await expect(dialog.getByLabel('Address')).toHaveValue('https://mcp.open-meteo.example.com');
  await expect(dialog.getByRole('checkbox', { name: 'forecast' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'air_quality' })).toBeChecked();
  expect(await calls(page)).toContain('worker:checkSource');
  // a dialog of its own over the catalog: no «Back», no «Browse the catalog»
  await expect(dialog.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Browse the catalog' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: "Connect to Pixel's skill Open-Meteo" })).toBeFocused();
});

// spec: add-pet-errands › Adapter connect flow › saved × a connect from the catalog
test('saved × a connect from the catalog: «Save adapter» leads to Pixel\'s page with Skill sheet open, the source in its socket and «Connected. …»', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker([], { checkSource: { tools: TOOLS } }) });
  await page.getByRole('button', { name: "Connect to Pixel's skill Moon phases" }).click();
  await connectSheet(page).getByRole('checkbox', { name: 'forecast' }).waitFor();
  await connectSheet(page).getByRole('button', { name: 'Save adapter' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  const dialog = skillSheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Connected. Pixel can use Moon phases from its next job.').first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Moon phases', exact: true })).toBeVisible();
  expect(await calls(page)).toContain('worker:saveSource:Moon phases');
});

// spec: add-pet-errands › Adapter catalog screen › success × the pet fell asleep meanwhile
test('success × the pet fell asleep meanwhile: «Back to Pixel» leads to its page without Skill sheet', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker() });
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toBeVisible();
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, skill: { label: LABEL }, owner: {} }, '2': BISCUIT } });
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(page.getByText('Pixel is asleep', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// spec: add-pet-errands › Adapter catalog screen › browse only
test('browse only: a player with a pet of their own by the address — every entry without «Connect», and the line why', async ({ page }) => {
  await openWith(page, '/adapters', { auth: SIGNED_IN, worker: ownerWorker() });
  await expect(page.getByText(BROWSE_LINE)).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(3);
  await expect(connectButtons(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
});

// spec: add-pet-errands › Adapter catalog screen › browse only
test('browse only: `?pet=` of a pet they don\'t own reads the same', async ({ page }) => {
  await openWith(page, '/adapters?pet=2', { auth: SIGNED_IN, worker: ownerWorker() });
  await expect(page.getByText(BROWSE_LINE)).toBeVisible();
  await expect(connectButtons(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
});

// spec: add-pet-errands › Adapter catalog screen › browse only × the pet given away
test('browse only × the pet given away: the pet is not theirs any more — the next connect meets the refusal and the page reads as browse only', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker() });
  await expect(connectButtons(page)).toHaveCount(3);
  await setWorker(page, { owned: [], me: { ...ME, currentPet: null, ownedCount: 1 }, checkSource: { fail: { status: 403, code: 'not_owner' } } });
  await page.getByRole('button', { name: "Connect to Pixel's skill Open-Meteo" }).click();
  await expect(page.getByText(BROWSE_LINE)).toBeVisible();
  await expect(connectButtons(page)).toHaveCount(0);
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Back to/ })).toHaveCount(0);
});

// spec: add-pet-errands › Adapter catalog screen › browse only, no pet
test('browse only, no pet: «Every adapter here is free. …» and «Get your own pet», which leads to hatching', async ({ page }) => {
  await openWith(page, '/adapters', { auth: SIGNED_IN, worker: { adapters: { entries: ENTRIES } } });
  await expect(page.getByText("Every adapter here is free. To connect one, you'll need a pet of your own.")).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(3);
  await expect(connectButtons(page)).toHaveCount(0);
  await expect(page.getByText(BROWSE_LINE)).toHaveCount(0);
  await page.getByRole('link', { name: 'Get your own pet' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByLabel('Name your pet')).toBeVisible();
});

// spec: add-pet-errands › Adapter catalog screen › signed-out
test('signed-out: a visitor sees every entry without «Connect», «Sign in to connect one to your pet\'s skill.», «Sign in» and «Get your own pet»', async ({ page }) => {
  await openWith(page, '/adapters', { worker: { adapters: { entries: ENTRIES } } });
  await expect(page.getByText("Sign in to connect one to your pet's skill.")).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(3);
  await expect(connectButtons(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Get your own pet' }).click();
  await expect(page).toHaveURL(/\/hatch$/);
  await expect(page.getByRole('button', { name: 'Sign in with Google to hatch your pet' })).toBeVisible();
});

// spec: add-pet-errands › Adapter catalog screen › signed-out × sign-in
test('signed-out × sign-in: «Sign in» leads back to the same address, read as the player\'s page — here «success» for the owner of `?pet=`', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { worker: ownerWorker() });
  await expect(page.getByText("Sign in to connect one to your pet's skill.")).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/adapters\?pet=9$/);
  await expect(connectButtons(page)).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Back to Pixel' })).toBeVisible();
  await expect(page.getByText("Sign in to connect one to your pet's skill.")).toHaveCount(0);
});

// spec: add-pet-errands › Adapter catalog screen › signed-out × sign-in
test('signed-out × sign-in: a player with a pet of their own, by the address, reads «browse only»', async ({ page }) => {
  await openWith(page, '/adapters', { worker: ownerWorker() });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(BROWSE_LINE)).toBeVisible();
  await expect(connectButtons(page)).toHaveCount(0);
});

// spec: add-pet-errands › Adapter sheet screen › success × Browse the catalog
test('success × Browse the catalog: the link opens `/adapters?pet=9`; «Back to Pixel» returns to Skill sheet and the typed fields are gone', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: ownerWorker() });
  await page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` }).click();
  await skillSheet(page).getByRole('button', { name: 'Add data' }).first().click();
  await connectSheet(page).getByLabel('Name it').fill('Typed name');
  await connectSheet(page).getByRole('link', { name: 'Browse the catalog' }).click();
  await expect(page).toHaveURL(/\/adapters\?pet=9$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Open-Meteo' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Pixel' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(skillSheet(page)).toBeVisible();
  await expect(connectSheet(page)).toHaveCount(0);
  await skillSheet(page).getByRole('button', { name: 'Add data' }).first().click();
  await expect(connectSheet(page).getByLabel('Name it')).toHaveValue('');
});

// spec: add-pet-errands › Adapter sheet screen › success × the session ends and sign-in returns
test('success × the session ends and sign-in returns: the sheet meets the ended-session line; «Sign in» brings the catalog back and the sheet on the same entry', async ({ page }) => {
  await openWith(page, '/adapters?pet=9', { auth: SIGNED_IN, worker: ownerWorker([], { checkSource: { tools: TOOLS } }) });
  await page.getByRole('button', { name: "Connect to Pixel's skill Open-Meteo" }).click();
  await connectSheet(page).getByRole('checkbox', { name: 'forecast' }).waitFor();
  await setWorker(page, { sessionExpired: true });
  await connectSheet(page).getByRole('button', { name: 'Save adapter' }).click();
  await expect(connectSheet(page).getByText(SESSION_LINE).first()).toBeVisible();
  await setWorker(page, { sessionExpired: false });
  await connectSheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/adapters\?pet=9$/);
  await expect(connectSheet(page)).toBeVisible();
  await expect(connectSheet(page).getByLabel('Name it')).toHaveValue('Open-Meteo');
  await expect(connectSheet(page).getByLabel('Address')).toHaveValue('https://mcp.open-meteo.example.com');
});
