// The placeholders of Feed sheet's copy, from the server's numbers (`Feed sheet screen`, `Snack rule`). The server sends yocto
// strings, cents and ISO times; the words are made here.

const HUNDREDTH = 10n ** 22n;
const THOUSANDTH = 10n ** 21n;

/** `{usd}`: whole US cents as the server rounded them, «5¢». */
export function usd(cents: number): string {
  return `${cents}¢`;
}

/** `{balance}`: the wallet's NEAR rounded down to two decimals; under 0.01 to three («0.006»; under 0.001 «0.000»). */
export function balance(yocto: string): string {
  const amount = BigInt(yocto);
  if (amount > 0n && amount < HUNDREDTH) {
    const thousandths = amount / THOUSANDTH;
    return `0.${thousandths.toString().padStart(3, '0')}`;
  }
  const hundredths = amount / HUNDREDTH;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/** `{date}`: the local date and time, «Nov 12 at 9:40 PM». */
export function dateAndTime(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at);
  // newer ICU puts a narrow no-break space before «PM»: the copy has a plain one
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(at).replace(/\s/g, ' ');
  return `${day} at ${time}`;
}

/** A name that stands at the start of a sentence: «your Pixel» (a friend's page) reads «Your Pixel». */
export function sentenceName(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}
