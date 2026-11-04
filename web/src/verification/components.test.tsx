// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mark, Receipt, ReceiptCall, ReceiptList, ReceiptRow } from '../ds/Verification';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Verification DS receipt components', () => {
  // spec: add-verification › Verification screen › success
  it('keeps paid facts before the tear and marks after it', async () => {
    await act(async () => root.render(<Receipt label="Oct 30, 2026" marks={<Mark>Character sealed at hatch</Mark>} foot="Done">
      <span>Reply</span><ReceiptCall tokens="1,240 tokens in · 236 out" />
    </Receipt>));
    const card = host.querySelector('article.ds-receipt')!;
    expect(card.getAttribute('aria-label')).toBe('Oct 30, 2026');
    expect(Array.from(card.children).map((el) => el.className)).toEqual([
      'ds-receipt__paid', 'ds-receipt__tear', 'ds-receipt__marks', 'ds-receipt__foot',
    ]);
    expect(card.querySelector('.ds-receipt-call .ds-mono')?.textContent).toBe('1,240 tokens in · 236 out');
  });

  // spec: add-verification › Verification flow › два вызова
  it('names controls inside a call with its own title and omits tokens for a stopped call', async () => {
    await act(async () => root.render(<ReceiptCall title="Web search" titleId="search-title" level={2}>
      <button aria-labelledby="download search-title">Download</button><span id="download">Download request bytes</span>
    </ReceiptCall>));
    expect(host.querySelector('h2#search-title')?.textContent).toBe('Web search');
    expect(host.querySelector('.ds-receipt-call .ds-mono')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-labelledby')).toBe('download search-title');
  });

  // spec: add-verification › Verification screen › success × receipt row
  it('keeps list order, a native keyboard link and a current row distinct from focus', async () => {
    await act(async () => root.render(<ReceiptList label="Latest receipts">
      <ReceiptRow href="/pet/9/verify/a" time="Oct 30, 14:02" model="Qwen3.8-27B" price="0.13¢" current />
      <ReceiptRow href="/pet/9/verify/b" time="Oct 29, 21:40" note="Paid by the game · no receipt" />
    </ReceiptList>));
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.ds-receipt-row')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/pet/9/verify/a', '/pet/9/verify/b']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.getAttribute('aria-current')).toBeNull();
    expect(links[0]?.tabIndex).toBe(0);
    expect(links[1]?.textContent).toContain('Paid by the game · no receipt');
  });

  // spec: add-verification › Verification screen › success × receipt row
  it('uses the DS focus ring and removes hover motion under reduced motion', () => {
    const css = readFileSync('src/ds/components.css', 'utf8');
    expect(css).toMatch(/\.ds-receipt-row:focus-visible\s*\{[^}]*outline:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ds-receipt-row\s*\{\s*transition: none;/);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.ds-receipt-row\[aria-current="page"\]\s*\{\s*border-color: Highlight;/);
  });
});
