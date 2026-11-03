// Where the focus goes after an outcome on the sheets of add-pet-errands (DS › Sheet › Focus, critic a11y M4): the control an outcome
// put in place of the one that had the focus. The sheet is found by its title; a sheet hidden behind its step is not it.

/** The open, shown sheet titled `title`. */
export function sheetTitled(title: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('.ds-sheet')).find((s) => s.closest('[hidden]') === null && s.querySelector('h2')?.textContent === title) ?? null;
}

/** The focus to the button named `label` in the sheet titled `title`. */
export function focusButton(title: string, label: string): void {
  const buttons = Array.from(sheetTitled(title)?.querySelectorAll<HTMLElement>('button') ?? []);
  buttons.find((b) => b.querySelector('.ds-button__label')?.textContent === label)?.focus();
}

/** The focus went with the control an outcome took away: it fell to the page's body. */
export const focusLost = () => document.activeElement === null || document.activeElement === document.body;
