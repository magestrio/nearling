import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Stage } from '../ds/Stage';
import { AdviceDock } from './AdviceDock';

// spec: add-game-layout › Pet stage rule › guest entries
it('keeps the guest advice composer in the Stage chat column', () => {
  const markup = renderToStaticMarkup(<Stage chat={<AdviceDock><p>Advice payment note</p></AdviceDock>} />);
  expect(markup).toMatch(/ds-stage__chat[^>]*><div class="ds-dock"><p>Advice payment note<\/p>/);
  expect(markup).not.toContain('advice-phone-dock-space');
  expect(markup).not.toContain('advice-dock-wrap');
});
