import { useEffect, useRef, useState } from 'react';
import { IconButton, Menu, MenuItem } from '../ds';
import type { Viewer } from '../screens/pet/parts';
import { useAuth } from '../seams/auth';
import { signOut } from '../signin/signOut';
import { openClearMemory } from './clearMemory';
import { sharedJobOf } from '../errands/sharedApproval';

// The Account control of every screen where the player has a session (`Account menu screen`): the header's round button and
// its menu — who is signed in, «Sign out» and, on the Pet screen of the player's own pet, «Clear {name}'s memory». It stays
// drawn after the session ended and then opens no menu: the tap shows the line (`Session expiry flow` › «сессия кончилась
// при открытом экране»). Built from design/bundle/screens/account.js › ownerMenu, design/ds/README.md › Menu.
export function AccountControl({ tokenId, name, viewer }: { /** the pet of the page, for the memory row */ tokenId?: string; name?: string; viewer?: Viewer }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!auth.authenticated) return null;

  const owner = viewer === 'owner' && Boolean(name) && Boolean(tokenId);
  const close = (by: 'escape' | 'tab') => {
    setOpen(false);
    // Esc returns the focus to «Account»; Tab lets it go on
    if (by === 'escape') opener.current?.focus();
  };

  return (
    <>
      <IconButton
        ref={opener}
        icon="account"
        label="Account"
        variant="secondary"
        haspopup="menu"
        expanded={open || undefined}
        onClick={() => {
          if (!auth.needSession()) return;
          setOpen((o) => !o);
        }}
      />
      {open ? (
        <Menu label="Account" note={auth.email ? `Signed in as ${auth.email}` : undefined} onClose={close}>
          {owner ? (
            <MenuItem
              first
              haspopup="dialog"
              onClick={() => {
                setOpen(false);
                // the session may have ended while the menu was open: then the same line, and nothing is opened
                if (!auth.needSession() || !tokenId) return;
                void sharedJobOf(tokenId).then((pet) => {
                  if (!alive.current) return;
                  // the menu that opened the dialog is gone by then: «Account» takes the focus back
                  openClearMemory({ tokenId, name: name ?? '', unsettledSharedJob: Boolean(pet?.shared_job && pet.shared_job.state !== 'settled'), returnFocusTo: () => opener.current });
                }).catch(() => {
                  if (!alive.current) return;
                  // The dialog's submit reads the chain again and refuses erasure if the owner cannot be checked.
                  openClearMemory({ tokenId, name: name ?? '', returnFocusTo: () => opener.current });
                });
              }}
            >
              {`Clear ${name}'s memory`}
            </MenuItem>
          ) : null}
          <MenuItem
            first={!owner}
            onClick={() => {
              setOpen(false);
              void signOut(auth);
            }}
          >
            Sign out
          </MenuItem>
        </Menu>
      ) : null}
    </>
  );
}
