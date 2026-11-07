import { petView } from '../chain';

export interface SocialFact { hireId: string; other: string; kind: 'bond' | 'quarrel' | 'reconcile' | 'help'; name: string }

/** Only already-settled, unused encounter codes can enter the existing paid diary request. */
export async function pendingSocial(env: Env, tokenId: string, day: number): Promise<SocialFact[]> {
  const rows = await env.DB.prepare(`SELECT hire_id, other_id, kind FROM society_encounters
    WHERE token_id = ? AND day < ? AND used_day IS NULL ORDER BY day, rowid LIMIT 3`)
    .bind(tokenId, day).all<{ hire_id: string; other_id: string; kind: SocialFact['kind'] }>();
  const facts: SocialFact[] = [];
  for (const row of rows.results) {
    const pet = await petView(env, row.other_id);
    if (pet !== null) facts.push({ hireId: row.hire_id, other: row.other_id,
      kind: row.kind, name: pet.name.replace(/[\r\n]/g, ' ').slice(0, 32) });
  }
  return facts;
}

/** A social line contains only a settled kind and the counterparty's public name. */
function fixedLine(fact: SocialFact): string {
  switch (fact.kind) {
    case 'bond': return `I think ${fact.name} and I are getting closer.`;
    case 'quarrel': return `${fact.name} and I had a rough day.`;
    case 'reconcile': return `I think ${fact.name} and I are finding our way back.`;
    case 'help': return `I have a story about helping ${fact.name} yesterday.`;
  }
}

/** Remove legacy model markers without using their prose; compose social lines on the Worker. */
export function composeSocial(text: string, facts: readonly SocialFact[]): { reply: string; lines: { fact: SocialFact; line: string }[] } {
  const reply = text.split(/\r?\n/).filter((raw) => !/^SOCIAL \d+:/.test(raw.trim())).join('\n').trim();
  return { reply, lines: facts.slice(0, 3).map((fact) => ({ fact, line: fixedLine(fact) })) };
}

export function socialLineStatements(db: D1Database, tokenId: string, day: number, epoch: number,
  lines: readonly { fact: SocialFact; line: string }[], presented: readonly SocialFact[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [index, item] of lines.entries()) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO society_diary_lines (token_id, day, slot, line, hire_id)
      SELECT ?, ?, ?, ?, ? WHERE COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?
        AND EXISTS (SELECT 1 FROM society_encounters WHERE hire_id = ? AND token_id = ? AND used_day IS NULL)`)
      .bind(tokenId, day, index + 1, item.line, item.fact.hireId, tokenId, epoch, item.fact.hireId, tokenId));
  }
  for (const fact of presented) {
    statements.push(db.prepare(`UPDATE society_encounters SET used_day = ? WHERE hire_id = ? AND token_id = ?
      AND used_day IS NULL AND COALESCE((SELECT memory_epoch FROM pets WHERE token_id = ?), 0) = ?`)
      .bind(day, fact.hireId, tokenId, tokenId, epoch));
  }
  return statements;
}
