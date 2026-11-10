import type { SealState } from '../../verification/seal';

export function sealLine(name: string, state: SealState): string {
  return state.kind === 'mismatch' ? `${name}'s character no longer matches the hatch record.`
    : state.kind === 'unavailable' ? `We can't check ${name}'s character on NEAR just now. Try again.`
      : state.kind === 'checked' ? `This mark checks that ${name} has the character sealed at birth. Game updates may change how we check it.` : '';
}
