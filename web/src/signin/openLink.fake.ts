// The e2e double of `openExternally`: the address is recorded as `open:<url>` (see `recordCall`) and the page stays where it
// is, as it does when the system has nothing to open an `intent://` link with.
import { recordCall } from '../seams/fakes';

export function fakeOpenExternally(url: string): void {
  recordCall(`open:${url}`);
}
