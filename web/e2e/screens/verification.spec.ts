import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { viewportsOf } from './copy';
import { FRAMES_DIR, captureFrame, readManifestFrames, writeComposite } from './harness';
import type { ScreenFixture } from './fixtures';
import { MISSING_ID, OLD_ID, THINK_ID, RECEIPT_CODE, receiptLinkFakes, verificationFakes } from '../verification.fixtures';

/** These capture cases are read by the browser run after the Verification route and receipt UI stages land. */
const fixtures: Record<string, ScreenFixture> = {
  // spec: add-verification › Verification screen › success
  'verify-success': { route: '/pet/9/verify', fakes: verificationFakes(),
    belowFold: ["See every pet's receipts on the explorer", "No reply", "Not on NEAR yet", "Paid by the game · no receipt"] },
  // spec: add-verification › Verification screen › loading
  'verify-loading': { route: '/pet/9/verify', fakes: verificationFakes({ loading: true }) },
  // spec: add-verification › Verification screen › error
  'verify-error': { route: '/pet/9/verify', fakes: verificationFakes({ missing: true }) },
  // spec: add-verification › Verification screen › чек слишком старый
  'verify-too-old': { route: `/pet/9/verify/${OLD_ID}`, fakes: verificationFakes({ old: true }) },
  // spec: add-verification › Verification screen › мысль не найдена
  'verify-thought-missing': { route: `/pet/9/verify/${MISSING_ID}`, fakes: verificationFakes() },
  // spec: add-verification › Verification screen › empty
  'verify-empty': { route: '/pet/9/verify', fakes: verificationFakes({ empty: true }),
    belowFold: ["No thoughts yet. Each of {name}'s thoughts gets a receipt here."] },
  // spec: add-verification › Verification screen › signed-out
  'verify-signed-out': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ signedOut: true }),
    belowFold: ["This page checks the signature, not whose key it is. NEAR AI's page checks the key against the model's secure hardware — but only keys in use right now."] },
  // spec: add-verification › Verification screen › asleep
  'verify-asleep': { route: '/pet/9/verify', fakes: verificationFakes({ asleep: true }) },
  // spec: add-verification › Verification record rule › характер не сошёлся
  'verify-character-mismatch': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'character-mismatch' }),
    belowFold: ["This character doesn't match the one sealed when {name} hatched.", "{name}'s character no longer matches the hatch record.", "Share exact bytes"] },
  // spec: add-verification › Seal of character rule › check unavailable
  'verify-unreachable': { route: '/pet/9/verify', fakes: verificationFakes({ variant: 'unread' }) },
  // spec: add-verification › Verification record rule › link not ready
  'verify-link-not-ready': { route: '/pet/9/verify', fakes: verificationFakes({ variant: 'link-not-ready' }),
    belowFold: ["Link appears shortly"] },
  // spec: add-verification › Verification flow › открыл чек
  'verify-checking': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'checking' }) },
  // spec: add-verification › Verification flow › проверка сошлась
  'verify-checked': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'checked' }),
    belowFold: ["Wearing now · saved by the game, not on NEAR", "Check the hardware on NEAR AI", "We can update the code with our key — every update is public.", "This page checks the signature, not whose key it is. NEAR AI's page checks the key against the model's secure hardware — but only keys in use right now.", "Sealed at hatch. This character matches the fingerprint {name} got on NEAR on {date}.", "Became a teen — {trait}", "Grew up — {trait}", "Share exact bytes", "This mark identifies {name}'s character hash checked on NEAR. The contract can be upgraded later."] },
  // spec: add-verification › Verification flow › не сошлось
  'verify-mismatch': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'mismatch' }),
    belowFold: ["Share exact bytes"] },
  // spec: add-verification › Verification flow › токены не сошлись
  'verify-tokens-mismatch': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'tokens-mismatch' }),
    belowFold: ["Share exact bytes"] },
  // spec: add-verification › Verification flow › ответ работника
  'verify-worker': { route: `/pet/5/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'worker' }) },
  // spec: add-verification › Verification flow › поток
  'verify-stream': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'stream' }) },
  // spec: add-verification › Verification flow › чек ещё не в сети
  'verify-pending': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'pending' }) },
  // spec: add-verification › Verification flow › чек ещё не в сети, память стёрта
  'verify-pending-cleared': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'pending-cleared' }) },
  // spec: add-verification › Verification flow › заплатил проект
  'verify-project-paid': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'project-paid' }) },
  // spec: add-verification › Verification flow › память стёрта
  'verify-memory-cleared': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'memory-cleared' }) },
  // spec: add-verification › Verification flow › два вызова
  'verify-two-calls': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'two-calls' }),
    belowFold: ["Quick re-ask"] },
  // spec: add-verification › Verification flow › вопрос найма
  'verify-hire-question': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'hire-question' }) },
  // spec: add-verification › Verification flow › пустой ответ
  'verify-empty-reply': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'empty-reply' }) },
  // spec: add-verification › Verification flow › skilled answer
  'verify-skilled': { route: `/pet/5/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'skilled' }),
    belowFold: ["A private skill shaped this answer, so its full request stays hidden — even from you.", "The signature and the receipt here are real."] },
  // spec: add-verification › Verification flow › skilled answer, another viewer
  'verify-skilled-public': { route: `/pet/5/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'skilled-public' }) },
  // spec: add-verification › Verification flow › errand report
  'verify-errand': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'errand' }),
    belowFold: ["Share exact bytes", "Report"] },
  // spec: add-verification › Verification flow › errand report with a cut search
  'verify-errand-cut': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'errand-cut' }),
    belowFold: ["The game stopped this call when {name} began a search it hadn't paid for. A stopped call has no signature or token counts."] },
  // spec: add-verification › Verification flow › errand with no search twice
  'verify-errand-none': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'errand-none' }) },
  // spec: add-verification › Verification flow › errand report with a skill
  'verify-errand-skill': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes({ variant: 'errand-skill' }),
    belowFold: ["{name}'s skill shaped this report, so its full request isn't kept — this page checks the reply and its token counts."] },
  // spec: add-verification › Share receipt dialog screen › success
  'share-receipt': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes(),
    prepare: async (page) => { await page.getByRole('button', { name: 'Share exact bytes' }).click(); } },
  // spec: add-verification › Share receipt dialog screen › error
  'share-receipt-error': { route: `/pet/9/verify/${THINK_ID}`, fakes: {
    ...verificationFakes(), worker: { ...verificationFakes().worker,
      publishReceipt: { fail: { status: 503, code: 'chain_unreachable' } } } },
    prepare: async (page) => { await page.getByRole('button', { name: 'Share exact bytes' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Publish receipt link' }).click();
      await page.getByText("We couldn't publish this receipt link. Nothing was shared. Try again.").waitFor(); } },
  // spec: add-verification › Receipt link flow › publish
  'share-receipt-published': { route: `/pet/9/verify/${THINK_ID}`, fakes: verificationFakes(),
    prepare: async (page) => { await page.getByRole('button', { name: 'Share exact bytes' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Publish receipt link' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Copy link' }).waitFor(); } },
  // spec: add-verification › Receipt link flow › visitor opens link
  'receipt-link': { route: `/receipt/${RECEIPT_CODE}`, fakes: receiptLinkFakes(),
    belowFold: ["Download reply bytes"] },
  // spec: add-verification › Receipt link flow › download error
  'receipt-link-download-error': { route: `/receipt/${RECEIPT_CODE}`, fakes: receiptLinkFakes({ downloadError: true }),
    prepare: async (page) => { await page.getByRole('button', { name: /Download request bytes.*Call 1/ }).click();
      await page.getByText("The bytes couldn't be downloaded just now. Try again.").filter({ visible: true }).first().waitFor(); } },
  // spec: add-verification › Receipt link flow › link revoked
  'receipt-link-revoked': { route: `/receipt/${RECEIPT_CODE}`, fakes: receiptLinkFakes({ revoked: true }) },
  // spec: add-verification › Receipt link flow › unknown link
  'receipt-link-unknown': { route: `/receipt/${RECEIPT_CODE}`, fakes: receiptLinkFakes({ unknown: true }) },
};

for (const frame of readManifestFrames()) {
  const fixture = fixtures[frame.id];
  if (!fixture) continue;
  for (const viewport of viewportsOf(frame)) {
    test(`${frame.id} · ${viewport}`, async ({ page, context }) => {
      const capture = await captureFrame(page, frame, viewport, fixture);
      if (fs.existsSync(path.join(FRAMES_DIR, `${frame.id}.${viewport}.png`))) {
        await writeComposite(context, frame, viewport, capture);
      }
    });
  }
}
