import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';

// design/ is the private side of the repo: a checkout without it has no DS source to compare with, hence no test
const source = Object.values(
  import.meta.glob<string>('../../../design/ds/components.js', { query: '?raw', import: 'default', eager: true }),
)[0];

/** The paths of one icon as design/ds/components.js › ICONS draws it. */
function dsPaths(dsComponents: string, name: string): string[] {
  const line = dsComponents.match(new RegExp(`^\\s*${name}: (\\[.*\\]),\\s*$`, 'm'));
  if (!line?.[1]) throw new Error(`no icon ${name} in design/ds/components.js`);
  return JSON.parse(line[1].replace(/'/g, '"')) as string[];
}

function drawnPaths(markup: string): string[] {
  return Array.from(markup.matchAll(/<path d="([^"]*)"/g), (m) => m[1] ?? '');
}

describe.skipIf(source === undefined)('Icon', () => {
  // spec: add-pet-work › Skill sheet screen › skill already written
  it('draws the skill as the DS merit rosette, not a hexagon', () => {
    expect(drawnPaths(renderToStaticMarkup(<Icon name="skill" />))).toEqual(dsPaths(source!, 'skill'));
  });
});
