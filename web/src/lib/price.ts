// `{price}` of the copy (PRODUCT.md §4): US cents, two significant digits, then «¢» — «0.12¢» for the approximate
// «Think hard», «0.13¢» for «Thought hard · {price}». The exact price to the yocto is in the receipt (add-verification).

export function formatCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return '0¢';
  if (cents >= 100) return `${Math.round(cents)}¢`;
  // toPrecision gives «0.12», «1.2», «12»; «0.40» keeps its zero: two significant digits
  return `${cents.toPrecision(2)}¢`;
}
