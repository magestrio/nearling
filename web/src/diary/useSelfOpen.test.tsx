// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ go: vi.fn(), signIn: { sheet: null as null | { kind: string } } }));
vi.mock('../signin/signIn', () => ({ useSignIn: () => mocks.signIn }));
vi.mock('../route', () => ({ go: mocks.go, diaryPath: (id: string) => `/pet/${id}/diary` }));

import { closeClearMemory, openClearMemory } from '../account/clearMemory';
import { useSelfOpen } from './useSelfOpen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const onNotice = vi.fn();
type Props = Parameters<typeof useSelfOpen>[0];
const base: Props = { tokenId: '9', diaryUnread: false, diary: false, wardrobe: false, asleep: false, typing: false, notice: 'cozy-scarf', onNotice };

function Screen(props: Props) {
  useSelfOpen(props);
  return null;
}

let root: Root | null = null;
async function show(props: Partial<Props> = {}) {
  if (root === null) root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Screen {...base} {...props} />));
}
const field = (inside?: HTMLElement) => {
  const area = document.createElement('textarea');
  (inside ?? document.body).appendChild(area);
  return area;
};

beforeEach(() => {
  onNotice.mockReset();
  mocks.go.mockReset();
  mocks.signIn.sheet = null;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  closeClearMemory();
  document.body.innerHTML = '';
});

describe('the New outfit notice opens by itself', () => {
  // spec: add-wardrobe › New outfit notice screen › success × a streak and a riddle item
  it('opens the due item when nothing holds it, once the page is rendered', async () => {
    await show();
    expect(onNotice).toHaveBeenCalledWith('cozy-scarf');
  });

  // spec: add-wardrobe › New outfit notice screen › success × a sign-in sheet open
  it('waits while a sign-in sheet stands and opens when it closes', async () => {
    mocks.signIn.sheet = { kind: 'closed_new' };
    await show();
    expect(onNotice).not.toHaveBeenCalled();
    mocks.signIn.sheet = null;
    await show({ typing: false });
    expect(onNotice).toHaveBeenCalledTimes(1);
  });

  // spec: add-wardrobe › New outfit notice screen › success × the Clear memory dialog open
  it('waits while Clear memory dialog stands and opens when it closes', async () => {
    await act(async () => openClearMemory({ tokenId: '9', name: 'Pixel' }));
    await show();
    expect(onNotice).not.toHaveBeenCalled();
    await act(async () => closeClearMemory());
    expect(onNotice).toHaveBeenCalledTimes(1);
  });

  // spec: add-wardrobe › New outfit notice screen › success × a line left in the field
  it('waits for an empty field of the page, focused or not, and takes no notice of a dialog\'s own field', async () => {
    const area = field();
    area.value = 'Tell me about the chart';
    await show();
    expect(onNotice).not.toHaveBeenCalled();
    area.value = '';
    await show({ typing: false });
    expect(onNotice).toHaveBeenCalledTimes(1);

    onNotice.mockReset();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    field(dialog).value = 'https://example.org/pet/9';
    await show({ notice: 'daisy-crown' });
    expect(onNotice).toHaveBeenCalledWith('daisy-crown');
  });

  // spec: add-wardrobe › New outfit notice screen › success × the owner on Wardrobe screen
  it('does not open on the Wardrobe, and opens when the owner is back on the Pet screen', async () => {
    await show({ wardrobe: true });
    expect(onNotice).not.toHaveBeenCalled();
    await show({ wardrobe: false });
    expect(onNotice).toHaveBeenCalledTimes(1);
  });

  // spec: add-wardrobe › New outfit notice screen › success × a menu open
  it('opens over a menu, a sheet, the Diary and an asleep pet', async () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    await show();
    expect(onNotice).toHaveBeenCalledWith('cozy-scarf');
    await show({ notice: 'thinking-cap', diary: true });
    expect(onNotice).toHaveBeenLastCalledWith('thinking-cap');
    await show({ notice: 'daisy-crown', asleep: true });
    expect(onNotice).toHaveBeenLastCalledWith('daisy-crown');
  });
});

describe('the Diary opens by itself', () => {
  // spec: add-daily-ritual › Daily ritual flow › сначала действие
  it('opens when it is due and nothing stands, once for a UTC day, and goes before the notice', async () => {
    await show({ diaryUnread: true });
    expect(mocks.go).toHaveBeenCalledWith('/pet/9/diary');
    expect(onNotice).not.toHaveBeenCalled();
    // the Diary stands: it does not open again, and the notice comes over it
    await show({ diaryUnread: true, diary: true });
    expect(mocks.go).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith('cozy-scarf');
  });

  // spec: add-daily-ritual › Daily ritual flow › сначала действие
  it('does not open on the Wardrobe or for an asleep pet', async () => {
    await show({ diaryUnread: true, wardrobe: true, notice: null });
    await show({ diaryUnread: true, asleep: true, notice: null });
    expect(mocks.go).not.toHaveBeenCalled();
  });

  // spec: add-daily-ritual › Daily ritual flow › встречает дневником
  it('opens after Back from the Wardrobe when no Diary was opened that day', async () => {
    await show({ diaryUnread: true, wardrobe: true, notice: null });
    expect(mocks.go).not.toHaveBeenCalled();
    await show({ diaryUnread: true, wardrobe: false, notice: null });
    expect(mocks.go).toHaveBeenCalledWith('/pet/9/diary');
  });
});
