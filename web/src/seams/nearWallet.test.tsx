// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNearWallet, type NearWallet } from './nearWallet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Props {
  ready?: boolean;
  authenticated?: boolean;
  linked?: string | null;
  create: () => Promise<string>;
  onCreated?: () => void;
}

let root: Root | null = null;
let seen: NearWallet;
let setProps: (p: Partial<Props>) => void;

function Probe(initial: Props) {
  const [props, set] = useState(initial);
  setProps = (p) => set((now) => ({ ...now, ...p }));
  const [noop] = useState(() => () => undefined);
  seen = useNearWallet({ ready: props.ready ?? true, authenticated: props.authenticated ?? true, linked: props.linked ?? null, create: props.create, onCreated: props.onCreated ?? noop });
  return null;
}

async function mount(props: Props) {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Probe {...props} />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('the NEAR wallet of a new player', () => {
  // spec: add-pet › Birth flow › вылупился
  it('is made once after sign-in, and the app waits for it: a token before it would be no session', async () => {
    let finish: (address: string) => void = () => undefined;
    const create = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const onCreated = vi.fn();
    await mount({ create, onCreated });
    expect(create).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ account: null, making: true });
    await act(async () => setProps({ linked: null }));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish('b'.repeat(64)));
    expect(seen).toMatchObject({ account: 'b'.repeat(64), making: false });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  // spec: add-pet › Birth flow › вылупился
  it('is not made for a player who has one, or before Privy knows the session, or for a visitor', async () => {
    const create = vi.fn(async () => 'x');
    await mount({ create, linked: 'a'.repeat(64) });
    expect(seen).toMatchObject({ account: 'a'.repeat(64), making: false });
    await act(async () => setProps({ linked: null, authenticated: false }));
    expect(seen).toMatchObject({ account: null, making: false });
    await act(async () => setProps({ ready: false, authenticated: true }));
    expect(seen.making).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  // spec: add-pet › Birth flow › вылупился
  it('does not hold the app when it fails, and the next tap tries again', async () => {
    const create = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('c'.repeat(64));
    await mount({ create });
    expect(seen).toMatchObject({ account: null, making: false });
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => seen.retry());
    expect(create).toHaveBeenCalledTimes(2);
    expect(seen.account).toBe('c'.repeat(64));
  });
});
