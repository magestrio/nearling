// A field is public only while its source note is retained, approved by the current owner,
// and backed by a billed report. The chain owner and generation are checked by callers.
import { ChainUnreachable, experienceView, type PetRecord } from '../chain';

type FieldRow = { token_id: string; wording: string; publisher: string; published_generation: number };

export async function publicFields(db: D1Database): Promise<Map<string, FieldRow>> {
  const rows = await db.prepare(
    `SELECT f.token_id, f.wording, f.publisher, f.published_generation
     FROM experience_field f JOIN experience_notes n ON n.source_thought_id = f.source_thought_id
     JOIN thoughts t ON t.id = n.source_thought_id
     LEFT JOIN pets p ON p.token_id = f.token_id
     WHERE n.token_id = f.token_id AND n.status = 'active'
       AND n.memory_epoch = COALESCE(p.memory_epoch, 0)
       AND n.approved_generation = f.published_generation
       AND t.status = 'billed' AND t.debit_tx_hash IS NOT NULL AND t.erased_at IS NULL`,
  ).all<FieldRow>();
  return new Map(rows.results.map((row) => [row.token_id, row]));
}

export function checkedField(fields: Map<string, FieldRow>, id: string, pet: PetRecord): string | null {
  const row = fields.get(id);
  return row?.publisher === pet.owner_id && row.published_generation === pet.transfer_generation
    ? row.wording : null;
}

export async function publicWorkLabels(env: Env, id: string, pet: PetRecord,
  fields: Map<string, FieldRow>): Promise<{ field: string | null; paidHires: number; completedErrands: number; countedSince: number }> {
  const counts = await experienceView(env, id);
  if (counts === null) throw new ChainUnreachable();
  return { field: checkedField(fields, id, pet), paidHires: counts.paid_hires,
    completedErrands: counts.completed_errands, countedSince: counts.counted_since };
}
