// The commit of a riddle: sha256 of the borsh bytes of (day: u64, riddle: String, answers: Vec<String>,
// salt: String) — `u64` little-endian, each string a `u32` little-endian length and its UTF-8 bytes, the
// vector a `u32` little-endian count and its strings. The contract recomputes it at the reveal
// (`contract/src/lib.rs`); `contract/tests/fixtures/riddle-hash.json` holds one vector both sides read.
// Written by hand: JSON would be two serializers to keep equal, and a joined string would make
// "ab" + "c" the same as "a" + "bc".
const enc = new TextEncoder();

export function riddleBytes(day: number, riddle: string, answers: readonly string[], salt: string): Uint8Array {
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    parts.push(b);
  };
  const text = (s: string) => {
    const bytes = enc.encode(s);
    u32(bytes.length);
    parts.push(bytes);
  };
  const dayBytes = new Uint8Array(8);
  new DataView(dayBytes.buffer).setBigUint64(0, BigInt(day), true);
  parts.push(dayBytes);
  text(riddle);
  u32(answers.length);
  for (const answer of answers) text(answer);
  text(salt);
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The hash the contract files: 64 lowercase hex characters. */
export async function riddleHash(day: number, riddle: string, answers: readonly string[], salt: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', riddleBytes(day, riddle, answers, salt)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
