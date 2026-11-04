import { expect, test, type Page } from '@playwright/test';
import type { SourceView, ToolView } from '../src/seams/worker-types';
import { ASLEEP_PIXEL, BISCUIT, calls, drawn, lookAgain, openWith, OWNER, PIXEL, reloadHolding, setWorker, SIGNED_IN } from './helpers';

// Adapter sheet and the sockets of Skill sheet (add-pet-errands › Adapter sheet screen, Adapter connect flow, Catalog flow): a step of
// Skill sheet where the owner connects one keyless data source — a public name, an address, the tools the pet may call — or opens
// its connected source; its outcomes come back to Skill sheet's sockets. The fakes answer the test call, the saves and the publish.
test.use({ timezoneId: 'Etc/GMT-2' });

const LABEL = 'opening lines';
const INSTRUCTION = 'Give one surprising opening line, then say in one sentence why it works.';
const ADDRESS = 'https://daybook.example.com/mcp';
const SESSION_LINE = "You've been signed out. Sign in to pick up where you left off.";
const ERROR_LINE = "We couldn't save that. Nothing's lost — try again.";
const NOT_WORKED = "That address didn't work. Use a plain https address that answers with no key. Nothing was saved.";

const TOOLS: ToolView[] = [
  { name: 'events_on', description: 'Notable events on a month and day.', params: [{ name: 'month', type: 'number', required: true }, { name: 'day', type: 'number', required: true }], tickable: true, ticked: true },
  { name: 'births_on', description: 'Well-known people born on a month and day.', params: [{ name: 'month', type: 'number', required: true }, { name: 'day', type: 'number', required: true }], tickable: true, ticked: true },
];
const source = (extra: Partial<SourceView> = {}): SourceView => ({ id: 's1', label: 'Daybook', tools: TOOLS, published: false, catalogGone: false, gift: false, ...extra });

const sheet = (page: Page) => page.getByRole('dialog');
const skillSheet = (page: Page) => page.getByRole('dialog', { name: "Pixel's skill" });
const connectSheet = (page: Page) => page.getByRole('dialog', { name: "Connect data to Pixel's skill" });
const connectedSheet = (page: Page) => page.getByRole('dialog', { name: "Daybook on Pixel's skill" });
const badge = (page: Page) => page.getByRole('button', { name: `Pixel's skill: Good at ${LABEL}` });
const socket = (page: Page, name: string) => skillSheet(page).getByRole('button', { name, exact: true });
const nameField = (page: Page) => sheet(page).getByLabel('Name it');
const addressField = (page: Page) => sheet(page).getByLabel('Address');
const check = (page: Page) => sheet(page).getByRole('button', { name: 'Check address' });
const saveAdapter = (page: Page) => sheet(page).getByRole('button', { name: 'Save adapter' });

/** Pixel with a saved skill and `sources` on it; the Skill sheet is open. */
const open = async (page: Page, sources: SourceView[] = [], extra: Record<string, unknown> = {}, pixel: typeof PIXEL | typeof ASLEEP_PIXEL = PIXEL) => {
  await openWith(page, '/pet/9', {
    auth: SIGNED_IN,
    worker: { ...OWNER, pets: { '9': { ...pixel, skill: { label: LABEL }, owner: {} }, '2': BISCUIT }, skill: { skill: { label: LABEL, instruction: INSTRUCTION }, sources }, ...extra },
  });
  await badge(page).click();
  await expect(skillSheet(page)).toBeVisible();
};
const connectNew = async (page: Page) => {
  await socket(page, 'Add data').first().click();
  await expect(connectSheet(page)).toBeVisible();
};
const typeSource = async (page: Page, label = 'Daybook', address = ADDRESS) => {
  await nameField(page).fill(label);
  await addressField(page).fill(address);
};

// spec: add-pet-errands › Adapter sheet screen › success
test('success: «Add data» opens the sheet with «Name it», «Address», their hints, «Check address» and «Browse the catalog»; «Back» returns to Skill sheet with its fields', async ({ page }) => {
  await open(page);
  await skillSheet(page).getByLabel('What is Pixel good at?').fill('plot twists');
  await connectNew(page);
  const dialog = connectSheet(page);
  await expect(dialog.getByRole('heading', { name: "Connect data to Pixel's skill" })).toBeVisible();
  await expect(nameField(page)).toHaveValue('');
  await expect(dialog.getByText('Anyone asking Pixel for help sees this name')).toBeVisible();
  await expect(dialog.getByText('Only keyless public data works here. Never paste a key or a password.')).toBeVisible();
  await expect(check(page)).toBeEnabled();
  await check(page).click();
  await expect(drawn(page, NOT_WORKED)).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Browse the catalog' })).toHaveAttribute('href', '/adapters?pet=9');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  // a step of Skill sheet: «Back» is there, and the skill's typing is where it was left
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(skillSheet(page).getByLabel('What is Pixel good at?')).toHaveValue('plot twists');
});

// spec: add-pet-errands › Adapter connect flow › address answered
test('address answered: the tools with their description and «Takes: …», the usable ones ticked, one that takes free text off with its line, «Save adapter»', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  const events = sheet(page).getByRole('checkbox', { name: 'events_on' });
  await expect(events).toBeChecked();
  // the focus goes to the first tool row (DS › Sheet › Focus)
  await expect(events).toBeFocused();
  await expect(events).toHaveAccessibleDescription(/Notable events on a date\. Takes: month \(number\), day \(number\)\./);
  const free = sheet(page).getByRole('checkbox', { name: 'search_events' });
  await expect(free).toBeDisabled();
  await expect(free).toHaveAccessibleDescription(/Takes free text — Pixel can only send short names, numbers, addresses or a pick from a list\./);
  await expect(saveAdapter(page)).not.toHaveAttribute('aria-disabled', 'true');
  expect(await calls(page)).toContain('worker:checkSource');
  // nothing ticked, nothing to save
  await events.uncheck();
  await expect(saveAdapter(page)).toBeDisabled();
  await events.check();
  await expect(saveAdapter(page)).toBeEnabled();
  // the tools were the old address's: an edit takes them away
  await addressField(page).fill(`${ADDRESS}2`);
  await expect(sheet(page).getByRole('checkbox')).toHaveCount(0);
});

// spec: add-pet-errands › Adapter connect flow › address didn't answer
test("address didn't answer: the line under «Address», nothing saved, the fields keep their text", async ({ page }) => {
  await open(page, [], { checkSource: { fail: { status: 422, code: 'address_failed' } } });
  await connectNew(page);
  await typeSource(page, 'Moon phases', 'http://moon.example.com/mcp');
  await check(page).click();
  await expect(drawn(page, NOT_WORKED)).toBeVisible();
  await expect(nameField(page)).toHaveValue('Moon phases');
  await expect(addressField(page)).toHaveValue('http://moon.example.com/mcp');
  await expect(sheet(page).getByRole('checkbox')).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.includes('saveSource'))).toEqual([]);
});

// spec: add-pet-errands › Adapter connect flow › a tool takes free text
test('a tool takes free text: with no tool left to tick «Save adapter» is inactive and «None of these tools fit, so Pixel can\'t use this one.»', async ({ page }) => {
  const FREE: ToolView[] = [{ name: 'ask_archive', description: 'Answers a question about the archive.', params: [{ name: 'question', type: 'text', required: true }], tickable: false, reason: 'free_text' }];
  await open(page, [], { checkSource: { tools: FREE } });
  await connectNew(page);
  await typeSource(page, 'Archive answers', 'https://archive.example.com/mcp');
  await check(page).click();
  await expect(sheet(page).getByRole('checkbox', { name: 'ask_archive' })).toBeDisabled();
  await expect(drawn(page, "None of these tools fit, so Pixel can't use this one.")).toBeVisible();
  await expect(saveAdapter(page)).toBeDisabled();
  // none fits: the focus stays on «Check address», the status says why
  await expect(check(page)).toBeFocused();
  await expect(sheet(page).locator('[role="status"]')).toContainText("None of these tools fit, so Pixel can't use this one.");
});

// spec: add-pet-errands › Adapter sheet screen › error
test('error: no answer to «Check address» is the line and «Try again»; the fields keep their text and «Try again» asks again', async ({ page }) => {
  await open(page, [], { checkSource: { fail: { status: 0, code: 'unreachable' } } });
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await expect(drawn(page, ERROR_LINE)).toBeVisible();
  await expect(nameField(page)).toHaveValue('Daybook');
  await expect(addressField(page)).toHaveValue(ADDRESS);
  await setWorker(page, { checkSource: undefined });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page).getByRole('checkbox', { name: 'events_on' })).toBeChecked();
  await expect(drawn(page, ERROR_LINE)).toHaveCount(0);
  expect((await calls(page)).filter((c) => c === 'worker:checkSource')).toHaveLength(2);
});

// spec: add-pet-errands › Adapter sheet screen › error
test('error: no answer to «Save adapter» keeps the sheet as it was, and «Try again» saves', async ({ page }) => {
  await open(page, [], { saveSource: { fail: { status: 502, code: 'bad_gateway' } } });
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await saveAdapter(page).click();
  await expect(drawn(page, ERROR_LINE)).toBeVisible();
  await expect(sheet(page).getByRole('checkbox', { name: 'events_on' })).toBeChecked();
  await setWorker(page, { saveSource: undefined });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(skillSheet(page)).toBeVisible();
  await expect(socket(page, 'Daybook')).toBeVisible();
});

// spec: add-pet-errands › Adapter connect flow › saved
test('saved: Skill sheet again with the source under its name in its socket and «Connected. Pixel can use Daybook from its next job.»', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await saveAdapter(page).click();
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(skillSheet(page)).toBeVisible();
  await expect(drawn(page, 'Connected. Pixel can use Daybook from its next job.')).toBeVisible();
  await expect(socket(page, 'Daybook')).toBeVisible();
  await expect(socket(page, 'Add data')).toHaveCount(2);
  expect(await calls(page)).toContain('worker:saveSource:Daybook');
  // the focus lands on Skill sheet's outcome line at its top (DS › Sheet › Focus)
  await expect(skillSheet(page).locator('.ds-note[tabindex="-1"]')).toBeFocused();
  await expect(skillSheet(page).locator('.ds-note[tabindex="-1"]')).toHaveText('Connected. Pixel can use Daybook from its next job.');
});

// spec: add-pet-errands › Adapter sheet screen › success × Back and Close
test('success × Back and Close: «Back» returns the focus to the socket that opened the step; «Close» closes both sheets onto the skill badge', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await connectSheet(page).getByRole('button', { name: 'Back' }).click();
  await expect(skillSheet(page)).toBeVisible();
  await expect(socket(page, 'Add data').first()).toBeFocused();
  await connectNew(page);
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(badge(page)).toBeFocused();
});

// spec: add-pet-errands › Adapter sheet screen › success × the session ends and «Back»
test('success × the session ends and «Back»: Skill sheet comes back with its fields and the ended-session line, not closed', async ({ page }) => {
  await open(page);
  await skillSheet(page).getByLabel('What is Pixel good at?').fill('plot twists');
  await connectNew(page);
  await typeSource(page);
  await setWorker(page, { sessionExpired: true });
  await check(page).click();
  await expect(connectSheet(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
  await connectSheet(page).getByRole('button', { name: 'Back' }).click();
  await expect(skillSheet(page)).toBeVisible();
  await expect(skillSheet(page).getByLabel('What is Pixel good at?')).toHaveValue('plot twists');
  await expect(skillSheet(page).getByText(SESSION_LINE).and(page.locator(':not(.ds-hidden)'))).toBeVisible();
  await expect(skillSheet(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
});

// spec: add-pet-errands › Adapter connect flow › saved × Skill sheet sockets
test('saved × Skill sheet sockets: the source is a socket that opens it; removed, the socket is empty again', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await saveAdapter(page).click();
  await socket(page, 'Daybook').click();
  await expect(connectedSheet(page)).toBeVisible();
  await connectedSheet(page).getByRole('button', { name: 'Remove' }).click();
  await expect(skillSheet(page)).toBeVisible();
  await expect(drawn(page, 'Daybook removed. Pixel stops using it from its next job.')).toBeVisible();
  await expect(socket(page, 'Add data')).toHaveCount(3);
  await expect(socket(page, 'Daybook')).toHaveCount(0);
});

// spec: add-pet-errands › Adapter sheet screen › a connected source
test('a connected source: its name, its tools with their ticks, «Save adapter», «Remove» and «Publish to the catalog» with its line', async ({ page }) => {
  await open(page, [source()]);
  await socket(page, 'Daybook').click();
  const dialog = connectedSheet(page);
  await expect(dialog.getByRole('heading', { name: "Daybook on Pixel's skill" })).toBeVisible();
  await expect(nameField(page)).toHaveValue('Daybook');
  await expect(addressField(page)).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'events_on' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'births_on' })).toBeChecked();
  await expect(dialog.getByText("Anyone will see this adapter's address and what its tools do, and can connect it to their pet's skill for free.")).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Publish to the catalog' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove' })).toBeVisible();
  // an edit: unticking one tool and saving tests the source again and says it is connected
  await dialog.getByRole('checkbox', { name: 'births_on' }).uncheck();
  await nameField(page).fill('Daybook 2');
  await saveAdapter(page).click();
  await expect(drawn(page, 'Connected. Pixel can use Daybook 2 from its next job.')).toBeVisible();
  expect(await calls(page)).toContain('worker:editSource:Daybook 2');
});

// spec: add-pet-errands › Catalog flow › publish
test('publish: «Publish to the catalog» lists it — «In the catalog.» and «Take it out» — and «Take it out» brings the button back', async ({ page }) => {
  await open(page, [source()]);
  await socket(page, 'Daybook').click();
  await connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' }).click();
  await expect(drawn(page, 'In the catalog.')).toBeVisible();
  await expect(connectedSheet(page).getByRole('button', { name: 'Take it out' })).toBeVisible();
  await expect(connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' })).toHaveCount(0);
  // the focus follows the swap (DS › Sheet › Focus)
  await expect(connectedSheet(page).getByRole('button', { name: 'Take it out' })).toBeFocused();
  await connectedSheet(page).getByRole('button', { name: 'Take it out' }).click();
  await expect(connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' })).toBeVisible();
  await expect(connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' })).toBeFocused();
  expect((await calls(page)).filter((c) => c.includes('ublishSource'))).toEqual(['worker:publishSource', 'worker:unpublishSource']);
});

// spec: add-pet-errands › Catalog flow › publish refused
test("publish refused: under the button «Some words in this adapter's address, tool names or descriptions can't go in the catalog. It still works for Pixel.»; nothing is published", async ({ page }) => {
  await open(page, [source()], { publishSource: { fail: { status: 409, code: 'insult' } } });
  await socket(page, 'Daybook').click();
  await connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' }).click();
  await expect(drawn(page, "Some words in this adapter's address, tool names or descriptions can't go in the catalog. It still works for Pixel.")).toBeVisible();
  await expect(connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' })).toBeVisible();
  await expect(connectedSheet(page).getByRole('button', { name: 'Take it out' })).toHaveCount(0);
  await expect(connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' })).toBeFocused();
});

// spec: add-pet-errands › Catalog flow › a source from a gift
test("a source from a gift: in place of «Publish to the catalog» «This adapter came with Pixel as a gift, so it can't go in the catalog. It still works for Pixel.»", async ({ page }) => {
  await open(page, [source({ gift: true })]);
  await socket(page, 'Daybook').click();
  await expect(drawn(page, "This adapter came with Pixel as a gift, so it can't go in the catalog. It still works for Pixel.")).toBeVisible();
  await expect(connectedSheet(page).getByRole('button', { name: 'Publish to the catalog' })).toHaveCount(0);
  // a copy of a catalog entry has no publish control either
});

// spec: add-pet-errands › Adapter connect flow › removed
test('removed: «Remove» takes the source off the skill: «Daybook removed. Pixel stops using it from its next job.»', async ({ page }) => {
  await open(page, [source()]);
  await socket(page, 'Daybook').click();
  await connectedSheet(page).getByRole('button', { name: 'Remove' }).click();
  await expect(drawn(page, 'Daybook removed. Pixel stops using it from its next job.')).toBeVisible();
  await expect(socket(page, 'Add data')).toHaveCount(3);
  expect(await calls(page)).toContain('worker:removeSource');
  await expect(skillSheet(page).locator('.ds-note[tabindex="-1"]')).toBeFocused();
});

// spec: add-pet-errands › Adapter connect flow › a fourth source
test('a fourth source: three sources fill the data sockets and the line says a skill holds up to 3', async ({ page }) => {
  await open(page, [source({ id: 's1' }), source({ id: 's2', label: 'Open-Meteo' }), source({ id: 's3', label: 'Moon phases' })]);
  await expect(socket(page, 'Add data')).toHaveCount(0);
  await expect(drawn(page, 'A skill holds up to 3 data sources. Remove one to add another.')).toBeVisible();
  await expect(socket(page, 'Moon phases')).toBeVisible();
});

// spec: add-pet-errands › Catalog flow › left the catalog
test('left the catalog: a copy whose entry is gone says so under its socket', async ({ page }) => {
  await open(page, [source(), source({ id: 's2', label: 'Open-Meteo', publicAddress: 'https://mcp.example.com/open-meteo', catalogGone: true })]);
  await expect(drawn(page, 'No longer in the catalog — still works for Pixel.')).toBeVisible();
  // a copy has no publish control
  await socket(page, 'Open-Meteo').click();
  await expect(sheet(page).getByRole('button', { name: 'Publish to the catalog' })).toHaveCount(0);
});

// spec: add-pet-errands › Adapter connect flow › no skill yet
test('no skill yet: «Add data» and «Add code» are inactive, with «Save the skill first, then add data to it.»', async ({ page }) => {
  await openWith(page, '/pet/9', { auth: SIGNED_IN, worker: { ...OWNER, pets: { '9': { ...PIXEL, skill: null, owner: {} }, '2': BISCUIT }, skill: { skill: null } } });
  await page.getByRole('button', { name: 'Teach Pixel a skill' }).click();
  const dialog = sheet(page);
  await expect(drawn(page, 'Save the skill first, then add data to it.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add data' })).toHaveCount(3);
  for (const s of await dialog.getByRole('button', { name: 'Add data' }).all()) await expect(s).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Add code' })).toBeDisabled();
});

// spec: add-pet-errands › Adapter sheet screen › success × the session ends and sign-in returns
test('success × the session ends and sign-in returns: the ended-session line and «Sign in»; back, the sheet opens with the name and the address, unchecked', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await setWorker(page, { sessionExpired: true });
  await lookAgain(page);
  await check(page).click();
  await expect(sheet(page).getByText(SESSION_LINE).first()).toBeVisible();
  expect((await calls(page)).filter((c) => c.includes('checkSource'))).toEqual([]);
  await expect(nameField(page)).toHaveValue('Daybook');
  await setWorker(page, { sessionExpired: false });
  await sheet(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/pet\/9$/);
  await expect(connectSheet(page)).toBeVisible();
  await expect(nameField(page)).toHaveValue('Daybook');
  await expect(addressField(page)).toHaveValue(ADDRESS);
  await expect(sheet(page).getByRole('checkbox')).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.includes('checkSource'))).toEqual([]);
});

// spec: add-pet-errands › Adapter sheet screen › success × the session ends and sign-in returns
test('success × 401 during Check address: the sheet and typing stay with Sign in', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await setWorker(page, { sessionExpired: true });
  await check(page).click();
  await expect(connectSheet(page).getByText(SESSION_LINE).and(page.locator(':not(.ds-hidden)'))).toBeVisible();
  await expect(nameField(page)).toHaveValue('Daybook');
  await expect(addressField(page)).toHaveValue(ADDRESS);
  await expect(connectSheet(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
});

// spec: add-pet-errands › Adapter sheet screen › success × reload
test('success × reload: a reload closes the sheet and what was typed is gone', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await reloadHolding(page);
  await expect(badge(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await badge(page).click();
  await connectNew(page);
  await expect(nameField(page)).toHaveValue('');
  await expect(addressField(page)).toHaveValue('');
});

// spec: add-pet-errands › Adapter sheet screen › not the owner × the pet given away with a sheet open
test('not the owner × the pet given away with a sheet open: the pet is not theirs any more — the sheet closes with the owner\'s page', async ({ page }) => {
  await page.clock.install();
  // Freeze periodic owner reads before opening the page; the refused check is this test's ownership event.
  await page.clock.pauseAt(Date.now());
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await setWorker(page, { owned: [], checkSource: { fail: { status: 403, code: 'not_owner' } } });
  await check(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('log')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Feed Pixel' }).first()).toBeVisible();
});

// spec: add-pet-errands › Adapter connect flow › saved
test('saved: a pet that fell asleep meanwhile has its Pet screen with the line and no Skill sheet', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await setWorker(page, { pets: { '9': { ...ASLEEP_PIXEL, skill: { label: LABEL }, owner: {} }, '2': BISCUIT } });
  await lookAgain(page);
  await saveAdapter(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawn(page, 'Connected. Pixel can use Daybook from its next job.')).toBeVisible();
});

// spec: add-pet-errands › Adapter connect flow › no skill yet × the skill forgotten in another tab
test('no skill yet × the skill forgotten in another tab: the refused save returns to Skill sheet with its unavailable sockets', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await setWorker(page, { saveSource: { fail: { status: 409, code: 'no_skill' } }, skill: { skill: null, sources: [] } });
  await saveAdapter(page).click();
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(drawn(page, 'Save the skill first, then add data to it.')).toBeVisible();
});

// spec: add-pet-errands › Adapter connect flow › a fourth source
test('a fourth source × another tab filled the sockets: refused Save adapter returns to the refreshed Skill sheet', async ({ page }) => {
  await open(page);
  await connectNew(page);
  await typeSource(page);
  await check(page).click();
  await setWorker(page, { saveSource: { fail: { status: 409, code: 'full' } }, skill: { skill: { label: LABEL, instruction: INSTRUCTION }, sources: [source({ id: 'a' }), source({ id: 'b' }), source({ id: 'c' })] } });
  await saveAdapter(page).click();
  await expect(connectSheet(page)).toHaveCount(0);
  await expect(drawn(page, 'A skill holds up to 3 data sources. Remove one to add another.')).toBeVisible();
});
