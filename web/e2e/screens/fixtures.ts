import type { Page } from '@playwright/test';
import type { FakeState } from '../../src/seams/fakes';

/** One frame's state in the real client, on the sample values of design/BRIEF.md §1. */
export interface ScreenFixture {
  /** Where the client is for this state. */
  route: string;
  /** What the seams (Worker, RPC, Privy) answer; handed to the page before it loads. */
  fakes?: FakeState;
  /** Steps after load that bring the state up (open a sheet, tap a control). */
  prepare?: (page: Page) => Promise<void>;
}

/**
 * Keyed by the frame id of design/bundle/manifest.json. Each entry carries its anchor on the line above:
 *
 *   // spec: <change> › <Requirement> › <Scenario>
 *   'pet-success-owner': { route: '/pets/…', fakes: {…} },
 *
 * Empty at Init: no frame exists in the client until the first change ports its screen. A frame of a
 * change that has no entry here makes `scripts/verify.sh <change>` fail its screens step.
 */
export const fixtures: Record<string, ScreenFixture> = {};
