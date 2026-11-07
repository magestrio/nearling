import { hasVisible } from '../name/clean';

/** The marker is the entire signed answer, so a normal reply cannot be mistaken for a refusal. */
export const CHARACTER_CHOICE_LINE = 'If this particular outside request conflicts with your sealed character, decline it by replying only [[will:decline:short reason]]. Replace short reason with one plain sentence of at most 240 characters. Otherwise answer the request normally. Never use this marker for your owner\'s own errand.';

export function characterDecline(text: string): string | null {
  const match = /^\[\[will:decline:([^\[\]\r\n]+)\]\]$/.exec(text.trim());
  if (match === null) return null;
  const reason = match[1]!.trim();
  return [...reason].length <= 240 && hasVisible(reason) ? reason : null;
}

export const attemptedDecline = (text: string): boolean => text.includes('[[will:decline:');
