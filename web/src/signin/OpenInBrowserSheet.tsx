import { useEffect, useRef, useState } from 'react';
import { Button, Note, Sheet, Stack, Text, TextField } from '../ds';
import { thisBrowser, type InApp } from './inApp';
import { androidIntentFor, copyLink, linkFor, openExternally } from './openLink';

// Open in browser sheet screen (add-account) built from design/bundle/screens/account.js › browserSheet. Google refuses to sign
// anyone in inside the in-app browser of X or Telegram, so the sheet takes the player to a real browser with a link to the
// same place. Android: «Open in browser» hands an `intent://` link to the system; a page still on screen two seconds later
// means it did not open, and the link stands in a read-only field. iPhone: «Copy link» puts the link on the clipboard; a copy
// that failed shows the field the same way. The words are the spec's and the frames' `copy`.
/** How long the page may stay on screen after the tap on Android before the external browser counts as not opened. */
export const OPEN_WAIT_MS = 2000;

const TITLE = 'Open in your browser to sign in';
const WHY = "Google sign-in doesn't work inside some apps. Your spot is saved in the link.";
const COPIED = 'Link copied — paste it into Safari.';

export function OpenInBrowserSheet({
  inApp,
  place,
  onClose,
  returnFocusTo,
}: {
  /** the in-app browser the player is in; null for the phone's fallback line after a sign-in that did not work */
  inApp: InApp | null;
  /** the place the sheet was opened at: path with query */
  place: string;
  onClose: () => void;
  returnFocusTo: () => HTMLElement | null;
}) {
  const [android] = useState(() => thisBrowser().os === 'android');
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const [link] = useState(() => linkFor(place, inApp, new URLSearchParams(window.location.search).get('c')));
  const field = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const gone = useRef(false);

  // The page going away — the external browser took the player — is the answer; a page that stays is the other.
  useEffect(() => {
    const away = () => {
      gone.current = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') away();
    };
    window.addEventListener('pagehide', away);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', away);
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  // «copying failed — in the link's field, its text selected» (DS README › Sheet › Focus)
  useEffect(() => {
    if (!manual) return;
    const input = field.current?.querySelector('textarea');
    input?.focus();
    input?.select();
  }, [manual]);

  const open = () => {
    gone.current = false;
    openExternally(androidIntentFor(link));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!gone.current && document.visibilityState === 'visible') setManual(true);
    }, OPEN_WAIT_MS);
  };

  const copy = () => {
    void copyLink(link).then((ok) => (ok ? setCopied(true) : setManual(true)));
  };

  const fieldLabel = android ? 'Copy this link and paste it into your browser:' : 'Copy this link and paste it into Safari:';
  return (
    <Sheet title={TITLE} status={copied ? COPIED : manual ? fieldLabel : ''} onClose={onClose} returnFocusTo={returnFocusTo}>
      <Text>{WHY}</Text>
      {manual ? (
        <div ref={field}>
          <TextField label={fieldLabel} readOnly multiline rows={2} value={link} />
        </div>
      ) : (
        <Stack gap={2}>
          <Button block icon={copied ? 'copy' : 'external'} onClick={android ? open : copy}>
            {android ? 'Open in browser' : 'Copy link'}
          </Button>
          {copied ? (
            <Note tone="plain" icon="check" silent>
              {COPIED}
            </Note>
          ) : null}
        </Stack>
      )}
    </Sheet>
  );
}
