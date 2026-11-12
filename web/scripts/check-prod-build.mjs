// A production-mode build must contain neither the day-1 checks route, nor any seam fake, nor the dev test sign-in.
// Builds into ../build/web-prod-check (gitignored) and searches the emitted files for their markers.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve('..', 'build', 'web-prod-check');
execFileSync('npx', ['vite', 'build', '--mode', 'production', '--outDir', out, '--emptyOutDir'], { stdio: 'ignore' });

const markers = ['Day-1 checks', '__NEARLING_FAKES__', 'fake-identity-token', 'nearling.testLogin'];
const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|css|html)$/.test(name)) {
      const text = readFileSync(path, 'utf8');
      for (const m of markers) if (text.includes(m)) found.push(`${m} in ${path}`);
    }
  }
};
walk(out);

if (found.length) {
  console.error(`the production build ships dev-only code:\n${found.join('\n')}`);
  process.exit(1);
}
console.log('production build: no day-1 route, no fakes');
