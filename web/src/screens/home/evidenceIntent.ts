/** A public README link keeps a signed-in visitor on Home's live numbers. */
export function hasEvidenceIntent(search: string): boolean {
  return new URLSearchParams(search).get('showcase') === 'numbers';
}
