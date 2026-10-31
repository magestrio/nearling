import { resetTime } from '../lib/time';

// The words of add-pet-life that the Pet screen draws, verbatim from the Scenarios: `Energy rule` › «энергия на нуле»
// and `Pet life display rule` › «владелец».

/** «Think hard» at zero energy: the note under the field; {time} is 00:00 UTC on the player's clock. */
export function energyLine(name: string, until?: string | null): string {
  return `${name} worked hard today and is out of energy for big thoughts until ${resetTime(until)}. Chatting still works.`;
}

/** A baby has no trait yet: this stands in their place. */
export function babyLine(name: string): string {
  return `${name} gets a trait when it grows up.`;
}
