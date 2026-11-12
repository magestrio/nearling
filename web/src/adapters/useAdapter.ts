import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi } from '../seams/worker';
import type { CatalogEntryView, SourceView, Token, ToolView } from '../seams/worker-types';

// The state machine of Adapter sheet (`Adapter sheet screen`, `Adapter connect flow`, `Catalog flow`): the connect form (a name, a typed
// address, «Check address», the tools with ticks, «Save adapter»), a connected source (its name, its ticks, «Remove», publish and
// «Take it out»), the error line with «Try again», the ended-session line. Connecting is free and writes nothing on the pet's chain
// side, so nothing here reads the pet's food. What is typed is the tab's memory; an own address is held only while it is typed.

export interface AdapterHost {
  tokenOf: () => Promise<Token | null>;
  /** the page's answer when the pet is no longer owned (`403 not_owner`) */
  refused: (e: unknown) => void;
  /** a source was saved or removed: the sheet is gone, the host says what happened where the player stands next */
  done: (result: { kind: 'saved' | 'removed'; label: string }) => void;
  /** «Back» of a step: the sheet it came from */
  back: () => void;
}

/** `step` — a step of Skill sheet (with «Back» and «Browse the catalog»); `catalog` — its own dialog over the catalog page. */
export type AdapterVariant = 'step' | 'catalog';
export type AdapterRequest = 'check' | 'save' | 'remove' | 'publish' | 'unpublish';
/** The line at the body's top: a request that did not come back (with «Try again»), or the ended session. */
export type AdapterTop = { kind: 'failed'; again: AdapterRequest } | { kind: 'session' };

/** Up to this many usable tools come ticked after a check; a source with more (a gateway such as Pipeworx serves ~50,
 * most off the skill's subject) comes with none, so the owner picks what the pet gets. */
export const AUTO_TICK_MAX = 5;
const statusOf = (e: unknown) => (e instanceof WorkerError ? e.status : 0);
const codeOf = (e: unknown) => (e instanceof WorkerError ? e.code : '');

export function useAdapter(tokenId: string, host: AdapterHost) {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const hostRef = useRef(host);
  hostRef.current = host;
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<AdapterVariant>('step');
  // the connected source being edited, null for a new one
  const [source, setSource] = useState<SourceView | null>(null);
  const [entry, setEntry] = useState<CatalogEntryView | null>(null);
  const [label, setLabelState] = useState('');
  const [address, setAddressState] = useState('');
  // the tools of the last test call (a new source); a connected source's are the source's own
  const [tools, setTools] = useState<ToolView[] | null>(null);
  const [ticks, setTicks] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [addressError, setAddressError] = useState(false);
  const [labelError, setLabelError] = useState(false);
  const [refused, setRefused] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const [top, setTop] = useState<AdapterTop | null>(null);
  const [busy, setBusy] = useState<AdapterRequest | null>(null);
  const live = useRef(0);
  const busyRef = useRef(false);
  const fields = useRef({ label, address, ticks, source, entry });
  fields.current = { label, address, ticks, source, entry };

  const clear = useCallback(() => {
    setTop(null);
    setAddressError(false);
    setLabelError(false);
    setRefused(false);
    setPublished(null);
    setBusy(null);
    busyRef.current = false;
  }, []);

  /** Closes the sheet where it stands (the host has its own place to go next). */
  const close = useCallback(() => {
    live.current += 1;
    setOpen(false);
    clear();
  }, [clear]);

  const begin = useCallback(() => {
    live.current += 1;
    clear();
    setTools(null);
    setTicks([]);
    setRevealed(false);
    setSource(null);
    setEntry(null);
    setOpen(true);
  }, [clear]);

  /** «Connect data» / a sign-in's return: the empty form, or the fields as typed (unchecked). */
  const openNew = useCallback(
    (typed?: { label: string; address: string }) => {
      begin();
      setVariant('step');
      setLabelState(typed?.label ?? '');
      setAddressState(typed?.address ?? '');
      fields.current.address = typed?.address ?? '';
    },
    [begin],
  );

  /** A connected source on Skill sheet; `typed` — the name as a sign-in brought it back. */
  const openSource = useCallback(
    (s: SourceView, typed?: { label: string }) => {
      begin();
      setVariant('step');
      setSource(s);
      setLabelState(typed?.label ?? s.label);
      setAddressState('');
      fields.current.address = '';
      setTicks(s.tools.filter((t) => t.ticked).map((t) => t.name));
    },
    [begin],
  );

  const setLabel = useCallback((v: string) => {
    setLabelState(v);
    setLabelError(false);
  }, []);
  const setAddress = useCallback((v: string) => {
    setAddressState(v);
    fields.current.address = v;
    // the tools were the old address's
    setTools(null);
    setTicks([]);
    setRevealed(false);
    setAddressError(false);
  }, []);
  const tick = useCallback((name: string, on: boolean) => setTicks((t) => (on ? (t.includes(name) ? t : [...t, name]) : t.filter((n) => n !== name))), []);

  /** One request of the sheet: the session first (an ended one meets its line and nothing is sent), then the call. */
  const run = useCallback(
    async <T,>(kind: AdapterRequest, work: (token: Token | null) => Promise<T>, ok: (r: T) => void, handle?: (status: number, code: string) => boolean) => {
      if (busyRef.current) return;
      if (!authRef.current.needSession()) {
        setTop({ kind: 'session' });
        return;
      }
      const gen = live.current;
      busyRef.current = true;
      setBusy(kind);
      setTop(null);
      try {
        const token = await hostRef.current.tokenOf();
        const result = await work(token);
        if (gen !== live.current) return;
        ok(result);
      } catch (e) {
        if (gen !== live.current) return;
        const status = statusOf(e);
        const code = codeOf(e);
        if (status === 401) {
          authRef.current.endSession(true, true);
          setTop({ kind: 'session' });
          return;
        }
        if (status === 403 && code === 'not_owner') {
          close();
          hostRef.current.refused(e);
          return;
        }
        if (handle?.(status, code)) return;
        setTop({ kind: 'failed', again: kind });
      } finally {
        if (gen === live.current) {
          busyRef.current = false;
          setBusy(null);
        }
      }
    },
    [close],
  );

  /** «Check address»: the test call; its tools, the usable ones ticked. */
  const check = useCallback(
    (given?: string) => {
      const typed = (given ?? fields.current.address).trim();
      if (typed === '') {
        setAddressError(true);
        return Promise.resolve();
      }
      return run(
        'check',
        (token) => workerApi.checkSource(token, tokenId, typed),
        (r) => {
          if (fields.current.address.trim() !== typed) return;
          setTools(r.tools);
          const usable = r.tools.filter((t) => t.tickable).map((t) => t.name);
          setTicks(usable.length <= AUTO_TICK_MAX ? usable : []);
          setAddressError(false);
          setRevealed(true);
        },
        (status, code) => {
          if (fields.current.address.trim() !== typed) return true;
          if (status === 422 && code === 'address_failed') {
            setAddressError(true);
            setTools(null);
            setTicks([]);
            return true;
          }
          return false;
        },
      );
    },
    [run, tokenId],
  );

  /** A catalog entry's «Connect to {name}'s skill»: its name and address, and the test call at once. */
  const openEntry = useCallback(
    (e: CatalogEntryView) => {
      begin();
      setVariant('catalog');
      setEntry(e);
      setLabelState(e.name);
      setAddressState(e.address);
      fields.current.address = e.address;
      void check(e.address);
    },
    [begin, check],
  );

  const handleSave = useCallback((status: number, code: string) => {
    if (status === 409 && (code === 'no_skill' || code === 'full')) {
      close();
      hostRef.current.back();
      return true;
    }
    if (status === 400 && code === 'bad_label') {
      setLabelError(true);
      return true;
    }
    if (status === 422 && code === 'address_failed') {
      setAddressError(true);
      return true;
    }
    return false;
  }, [close]);

  /** «Save adapter»: the test call again on the server, then the source is on the skill. */
  const save = useCallback(
    () =>
      run(
        'save',
        (token) => {
          const f = fields.current;
          if (f.source) return workerApi.editSource(token, tokenId, f.source.id, { label: f.label, ticks: f.ticks });
          return workerApi.saveSource(token, tokenId, { label: f.label, ...(f.entry ? { entry: f.entry.id } : { address: f.address.trim() }), ticks: f.ticks });
        },
        (r) => {
          close();
          hostRef.current.done({ kind: 'saved', label: r.source.label });
        },
        handleSave,
      ),
    [run, tokenId, close, handleSave],
  );

  /** «Remove»: the source and its own entry in the catalog go. */
  const remove = useCallback(() => {
    const s = fields.current.source;
    if (!s) return Promise.resolve();
    return run(
      'remove',
      (token) => workerApi.removeSource(token, tokenId, s.id),
      () => {
        close();
        hostRef.current.done({ kind: 'removed', label: s.label });
      },
    );
  }, [run, tokenId, close]);

  /** «Publish to the catalog»: listed, or the line why not. */
  const publish = useCallback(() => {
    const s = fields.current.source;
    if (!s) return Promise.resolve();
    setRefused(false);
    return run(
      'publish',
      (token) => workerApi.publishSource(token, tokenId, s.id),
      (r) => {
        setSource(r.source);
        setPublished('In the catalog.');
      },
      (status, code) => {
        if (status === 409 && code === 'insult') {
          setRefused(true);
          return true;
        }
        if (status === 409 && (code === 'gift' || code === 'copy')) {
          setSource({ ...s, gift: code === 'gift' ? true : s.gift });
          return true;
        }
        return false;
      },
    );
  }, [run, tokenId]);

  /** «Take it out»: the entry leaves the catalog at once. */
  const unpublish = useCallback(() => {
    const s = fields.current.source;
    if (!s) return Promise.resolve();
    return run(
      'unpublish',
      (token) => workerApi.unpublishSource(token, tokenId, s.id),
      (r) => {
        setSource(r.source);
        setPublished(null);
      },
    );
  }, [run, tokenId]);

  /** «Try again»: the request that did not come back, once more. */
  const again = useCallback(() => {
    if (top?.kind !== 'failed') return;
    const next = { check: () => check(), save, remove, publish, unpublish }[top.again];
    void next();
  }, [top, check, save, remove, publish, unpublish]);

  return {
    open,
    variant,
    source,
    entry,
    label,
    address,
    tools,
    ticks,
    revealed,
    addressError,
    labelError,
    refused,
    published,
    top,
    busy,
    fields,
    openNew,
    openSource,
    openEntry,
    close,
    back: () => {
      close();
      hostRef.current.back();
    },
    setLabel,
    setAddress,
    tick,
    check,
    save,
    remove,
    publish,
    unpublish,
    again,
  };
}
