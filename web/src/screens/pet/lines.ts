// The words the Pet screen and the Diary screen say of the same conversation (`add-pet` › `Conversation flow`, `Connection rule`,
// `Daily cap rule`): the question of the day goes through the same pipeline as any line to the pet, so its thinking line, its
// refusals and its pause are the same lines.
import { resetTime } from '../../lib/time';

export const WAIT_LINE = 'Still working on it — long answers can take a minute or two.';
export const thinkingLine = (name: string, deep = false) => `${name} is thinking${deep ? ' hard' : ''}…`;
export const lostLine = (name: string) => `${name} lost that thought. Nothing was spent — try again.`;
export const emptyPaidLine = (name: string) => `${name} lost that thought, but it still used a little food. Your message is kept — try again.`;
export const pausedLine = (name: string) => `Chatting is paused on our side while we top up. Your message is kept — ${name} will be back soon.`;
/** `Connection rule` › «сервер недоступен» over the pet's page; Errand sheet's status says it too while the sheet covers the page */
export const offlineLine = (name: string) => `Can't reach ${name} right now. Nothing's lost — try again in a moment.`;
export const tiredLine =(name: string, until: string | undefined) => `${name} is tired for today. Back at ${resetTime(until)}.`;
