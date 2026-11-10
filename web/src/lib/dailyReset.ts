/** Wait for the Worker's UTC reset. The HTTP Date header supplies the clock for this response. */
export function dailyResetDelay(until: string | undefined, serverTime: string | undefined): number {
  const reset = Date.parse(until ?? '');
  const server = Date.parse(serverTime ?? '');
  if (Number.isFinite(reset) && Number.isFinite(server)) return Math.max(0, reset - server);
  // A response without Date cannot establish whether a browser clock ahead of the Worker has passed the reset.
  // Wait for the next local observation of 00:00 UTC, then use bounded retries if the Worker still says closed.
  const now = Date.now();
  return Number.isFinite(reset) && reset > now ? reset - now : 86_400_000 - (now % 86_400_000);
}
