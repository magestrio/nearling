import { useEffect, useRef } from 'react';
import { Button, Cluster, Divider, Note, Sheet, Stack, Text, TextField, TextLink, ToolList, ToolRow } from '../ds';
import { focusButton, sheetTitled } from '../errands/focus';
import { useMarkErrandSurface } from '../errands/surfaces';
import { useSignInLines } from '../signin/SignInOutcome';
import { SKILL_LABEL_REJECTED } from '../work/lines';
import {
  ADAPTER_ERROR,
  ADDRESS_FAILED,
  ADDRESS_FIELD,
  ADDRESS_HINT,
  adapterTitle,
  BROWSE_CATALOG,
  CHECK_ADDRESS,
  connectedTitle,
  freeTextNote,
  giftLine,
  IN_CATALOG,
  NAME_FIELD,
  nameHint,
  noneFitLine,
  PUBLISH,
  PUBLISH_NOTE,
  publishRefusedLine,
  REMOVE,
  SAVE_ADAPTER,
  TAKE_OUT,
  TOOLS_LABEL,
} from './lines';
import { toolDescription } from './params';
import type { useAdapter } from './useAdapter';

// Adapter sheet (`Adapter sheet screen`, `Adapter connect flow`, `Catalog flow`) drawn from design/bundle/screens/adapter.js: a step of Skill
// sheet with «Back» (from the catalog, its own centred dialog with no «Browse the catalog»). Top to bottom: the outcome line; «Name it»;
// «Address» (new sources only — an own address is shown only while it is typed); «Browse the catalog» and «Check address»; after the
// check the tools with their ticks. A connected source shows its name and tools, and after a hairline the publish block; «Save adapter»
// (and «Remove», for a connected one) stand in the sheet's foot.

export function AdapterSheet({ name, adapter, tokenId, onClose }: { name: string; adapter: ReturnType<typeof useAdapter>; tokenId: string; onClose: () => void }) {
  const { open, source, tools: checked, ticks, top, busy, variant } = adapter;
  // a session that ended meets the line of `Session expiry flow`: «Sign in» brings the sheet back with the name and the typed address
  const [session] = useSignInLines({ text: JSON.stringify({ label: adapter.label, address: adapter.address, ...(source ? { sid: source.id } : {}) }), action: 'adapter' });
  useMarkErrandSurface(open);

  // Where the focus goes after an outcome (DS › Sheet › Focus): «Check address» answered — the first tool row that can be ticked (none
  // fits: it stays on «Check address», the status says why); published — «Take it out»; taken out — «Publish to the catalog»; refused
  // — it stays on «Publish to the catalog», which stood throughout
  const title = source !== null ? connectedTitle(source.label, name) : adapterTitle(name);
  const checkTapped = useRef(false);
  useEffect(() => {
    if (busy === 'check' || !checkTapped.current) return;
    checkTapped.current = false;
    if (checked !== null) sheetTitled(title)?.querySelector<HTMLInputElement>('.ds-tool__check:not(:disabled)')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  const listed = open && source !== null ? source.published : null;
  const listedBefore = useRef<boolean | null>(null);
  useEffect(() => {
    if (listedBefore.current !== null && listed !== null && listed !== listedBefore.current) focusButton(title, listed ? TAKE_OUT : PUBLISH);
    listedBefore.current = listed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed]);
  if (!open) return null;

  const step = variant === 'step';
  const connected = source !== null;
  const list = connected ? source.tools : checked;
  const fits = (list ?? []).some((t) => t.tickable);
  const canSave = adapter.label !== '' && ticks.length > 0 && (connected || checked !== null);

  const published = connected && source.published;
  const statusParts = [
    top?.kind === 'failed' ? ADAPTER_ERROR : top?.kind === 'session' ? (session?.text ?? '') : '',
    adapter.addressError ? ADDRESS_FAILED : '',
    adapter.refused ? publishRefusedLine(name) : '',
    adapter.published ?? '',
    !connected && checked !== null ? `${checked.map((t) => t.name).join(', ')}${fits ? '' : `. ${noneFitLine(name)}`}` : '',
  ].filter(Boolean);

  const topLine =
    top?.kind === 'failed' ? (
      <Stack gap={2}>
        <Note tone="error" silent>
          {ADAPTER_ERROR}
        </Note>
        <Cluster justify="flex-end">
          <Button variant="secondary" size="compact" onClick={adapter.again}>
            Try again
          </Button>
        </Cluster>
      </Stack>
    ) : top?.kind === 'session' ? (
      <Cluster gap={3} justify="space-between">
        <Note tone="error" silent>
          {session?.text}
        </Note>
        {session?.action ? (
          <Button variant="secondary" size="compact" onClick={session.action.onClick}>
            {session.action.label}
          </Button>
        ) : null}
      </Cluster>
    ) : connected && adapter.addressError ? (
      <Note tone="error" silent>
        {ADDRESS_FAILED}
      </Note>
    ) : null;

  const rows = list?.map((t) => (
    <ToolRow
      key={t.name}
      name={t.name}
      description={toolDescription(t)}
      checked={t.tickable && ticks.includes(t.name)}
      disabled={!t.tickable}
      note={t.tickable ? undefined : freeTextNote(name)}
      onChange={(on) => adapter.tick(t.name, on)}
    />
  ));

  const publishBlock = !connected ? null : published ? (
    <Cluster gap={3} justify="space-between">
      <Text variant="small">{IN_CATALOG}</Text>
      <Button variant="ghost" size="compact" busy={busy === 'unpublish'} onClick={() => void adapter.unpublish()}>
        {TAKE_OUT}
      </Button>
    </Cluster>
  ) : source.publicAddress !== undefined ? null : source.gift ? (
    <Text variant="small" tone="secondary">
      {giftLine(name)}
    </Text>
  ) : (
    <Stack gap={2}>
      <Text variant="small" tone="secondary">
        {PUBLISH_NOTE}
      </Text>
      <Cluster>
        <Button variant="secondary" size="compact" icon="share" busy={busy === 'publish'} onClick={() => void adapter.publish()}>
          {PUBLISH}
        </Button>
      </Cluster>
      {adapter.refused ? (
        <Note tone="error" silent>
          {publishRefusedLine(name)}
        </Note>
      ) : null}
    </Stack>
  );

  const foot = connected ? (
    <Cluster gap={3} justify="space-between">
      <Button variant="ghost" size="compact" busy={busy === 'remove'} off={busy !== null && busy !== 'remove'} onClick={() => void adapter.remove()}>
        {REMOVE}
      </Button>
      <Button size="compact" disabled={!canSave} busy={busy === 'save'} onClick={() => void adapter.save()}>
        {SAVE_ADAPTER}
      </Button>
    </Cluster>
  ) : checked !== null ? (
    <Cluster justify="flex-end">
      <Button size="compact" disabled={!canSave} busy={busy === 'save'} onClick={() => void adapter.save()}>
        {SAVE_ADAPTER}
      </Button>
    </Cluster>
  ) : undefined;

  return (
    <Sheet
      title={title}
      column={step}
      centered={!step}
      onBack={step ? adapter.back : undefined}
      status={statusParts.join(' ')}
      busy={busy === 'save' || busy === 'remove'}
      foot={foot}
      onClose={onClose}
    >
      <Stack gap={5}>
        {topLine}
        <TextField
          label={NAME_FIELD}
          value={adapter.label}
          onChange={adapter.setLabel}
          maxLength={40}
          count
          hint={nameHint(name)}
          error={adapter.labelError ? SKILL_LABEL_REJECTED : undefined}
        />
        {connected ? null : (
          <>
            <TextField label={ADDRESS_FIELD} value={adapter.address} onChange={adapter.setAddress} mono hint={ADDRESS_HINT} error={adapter.addressError ? ADDRESS_FAILED : undefined} />
            <Cluster gap={3} justify={step ? 'space-between' : 'flex-end'}>
              {step ? (
                <TextLink href={`/adapters?pet=${tokenId}`} iconEnd="chevron">
                  {BROWSE_CATALOG}
                </TextLink>
              ) : null}
              <Button
                variant={checked !== null ? 'secondary' : 'primary'}
                size="compact"
                busy={busy === 'check'}
                onClick={() => {
                  checkTapped.current = true;
                  void adapter.check();
                }}
              >
                {CHECK_ADDRESS}
              </Button>
            </Cluster>
            {checked !== null ? <Divider /> : null}
          </>
        )}
        {list ? <ToolList label={TOOLS_LABEL} reveal={adapter.revealed}>{rows}</ToolList> : null}
        {!connected && checked !== null && !fits ? (
          <Note tone="plain" silent>
            {noneFitLine(name)}
          </Note>
        ) : null}
        {publishBlock ? <Divider /> : null}
        {publishBlock}
      </Stack>
    </Sheet>
  );
}
