import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { HatchNotices } from './HatchScreen';

// spec: add-pet-will › Will chain disclosure data › savings notice
it('names the public wish reserve in the existing birth and gift notice', () => {
  const html = renderToStaticMarkup(<HatchNotices name="Pixel" />);
  expect(html).toContain('Saved food and a bought outfit are public on NEAR forever. The wish&#x27;s words stay private.');
  expect(html).toContain('every outfit, meal and thought receipt');
});
