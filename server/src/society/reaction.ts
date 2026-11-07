import type { Stance, Reaction } from './relations';

/** A short model instruction inside the existing paid answer. The code is metadata, never pet prose. */
export function pairInstruction(payerName: string, workerName: string, stance: Stance): string {
  return `You are ${JSON.stringify(workerName)} helping ${JSON.stringify(payerName)}. Your current pair stance is ${stance}. After the answer, optionally append exactly one code [[society:respectful]] or [[society:rude]] only if your reaction is clear. Do not put the code in your spoken answer.`;
}

export function parseReaction(text: string): { reply: string; reaction: Reaction | null } {
  const markers = [...text.matchAll(/\[\[society:([a-z]{1,20})\]\]/g)];
  const tail = text.trimEnd();
  const final = markers.length === 1 && markers[0]!.index + markers[0]![0].length === tail.length;
  const code = final ? markers[0]![1] : null;
  return {
    reply: text.replace(/\[\[society:[^\]\r\n]{0,40}\]\]/g, '').trim(),
    reaction: code === 'respectful' || code === 'rude' ? code : null,
  };
}
