/** The code of the link the owner has just prepared from Errand sheet. The shared page says who can read the job once,
 *  on arrival from «Share a job for friends to fund» (`Friend-funded errand flow` › «owner shares a job»); a reload or a
 *  later visit is not that moment, so nothing is kept in browser storage. */
let justPrepared: string | null = null;

export function markPrepared(code: string): void {
  justPrepared = code;
}

/** A read with no effect, for a render that may run twice. */
export const peekPrepared = (code: string): boolean => justPrepared === code;

export function takePrepared(code: string): void {
  if (justPrepared === code) justPrepared = null;
}
