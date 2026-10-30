import { useRef, type ReactNode } from 'react';
import { announceClear, closeClearMemory, useClearRequest } from './clearMemory';
import { ClearMemoryDialog } from './ClearMemoryDialog';

// Where the Clear memory dialog stands: beside the page, like the sign-in sheets, so a page that changes under it (the pet was
// given away meanwhile, `Memory deletion flow` › «уже не владелец») does not take it along. The page under the modal dialog is
// out of reach (`inert`) and stays at one place of the tree, so the screen keeps its state while the dialog is open.
export function ClearMemoryLayer({ children }: { children: ReactNode }) {
  const request = useClearRequest();
  // after a clear that started on a page of its own, the owner's input takes the focus (DS › Sheet › Focus)
  const cleared = useRef(false);
  const open = request !== null;

  return (
    <>
      <div className="ds-only" inert={open || undefined}>
        {children}
      </div>
      {/* the dialog is beside the Shell, which is where the DS sets the text colour and the font: the tokens are given here */}
      <div className="ds-only" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-sans)' }}>
        {request ? (
          <ClearMemoryDialog
            key={request.tokenId}
            tokenId={request.tokenId}
            name={request.name}
            onClose={closeClearMemory}
            onDone={() => {
              cleared.current = true;
              announceClear({ tokenId: request.tokenId, result: 'cleared' });
              closeClearMemory();
              request.onDone?.();
            }}
            onNotOwner={() => {
              announceClear({ tokenId: request.tokenId, result: 'not_owner' });
              closeClearMemory();
            }}
            returnFocusTo={() => {
              const done = cleared.current;
              cleared.current = false;
              if (done && !request.onDone) return document.querySelector<HTMLElement>('.ds-composer__field');
              return request.returnFocusTo?.() ?? null;
            }}
          />
        ) : null}
      </div>
    </>
  );
}
