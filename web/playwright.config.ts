import { defineConfig } from '@playwright/test';

const PORT = 5199;

// Chromium exactly as designer-near's frames.mjs drives it (headless, no device emulation); the screens
// project adds the 2x scale of the frames' PNGs and software WebGL so the 3D pet renders headless.
export default defineConfig({
  outputDir: '../build/playwright',
  fullyParallel: true,
  // the 3D pet is drawn by software GL here (swiftshader): several pages at once starve each other for seconds, and the
  // first draw of Home's ten-pet meadow alone holds a page's main thread for ~13 s (measured, add-account stage 10), so
  // what the DOM waits behind it gets a ceiling above that
  expect: { timeout: 45_000 },
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    // The e2e mode swaps the seams (Worker, RPC, Privy) for fakes; nothing leaves the machine.
    command: `npx vite --mode e2e --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'e2e', testDir: './e2e', testIgnore: '**/screens/**', testMatch: '**/*.spec.ts' },
    // `{time}` of the frames is 02:00: 00:00 UTC seen from UTC+2 (design/BRIEF.md §1).
    // A capture waits on frames of the software-GL pet (the pet's first draw, its freeze, two screenshots): with eight
    // workers on a loaded machine one frame took 6–29 s (measured, add-pet-work fix round 3), so a capture runs past
    // Playwright's default 30 s while every wait of it is still on its way. The budget is the capture's whole run.
    {
      name: 'screens',
      testDir: './e2e/screens',
      testMatch: '**/*.spec.ts',
      timeout: 120_000,
      use: { deviceScaleFactor: 2, timezoneId: 'Etc/GMT-2' },
    },
  ],
});
