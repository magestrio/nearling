// Owner review and public paid-work record. Every private request checks the current chain owner;
// a transfer generation makes an earlier owner's approval inert even if a gift races a D1 read.
import { Hono } from 'hono';
import { ChainUnreachable, experienceView, petView, type PetRecord } from '../chain';
import { TOKEN_ID, requireSession, type AppEnv } from '../http';
import { memoryEpoch } from '../pet/forget';
import { ownedPet } from './thoughts';
import { track } from '../track';
import { OPAQUE_ID, recordExperienceEvent } from '../experience/events';

export const experienceRoutes = new Hono<AppEnv>();
const NOTE_ID = /^[0-9a-f]{24}$/;

interface NoteRow {
  source_thought_id: string;
  source_report_id: string;
  note_text: string;
  proposed_field: string;
  created_at: number;
  approved_generation: number | null;
  source_form: 'read' | 'find' | 'check';
}

async function currentNotes(db: D1Database, id: string, pet: PetRecord): Promise<NoteRow[]> {
  const epoch = await memoryEpoch(db, id);
  const rows = await db.prepare(
    `SELECT n.source_thought_id, n.source_report_id, n.note_text, n.proposed_field,
       n.created_at, n.approved_generation, t.form AS source_form
     FROM experience_notes n JOIN thoughts t ON t.id = n.source_thought_id
     WHERE n.token_id = ? AND n.status = 'active' AND n.memory_epoch = ?
       AND t.status = 'billed' AND t.debit_tx_hash IS NOT NULL AND t.erased_at IS NULL
     ORDER BY n.created_at DESC, n.source_thought_id DESC LIMIT 6`,
  ).bind(id, epoch).all<NoteRow>();
  return rows.results.map((row) => ({ ...row,
    approved_generation: row.approved_generation === pet.transfer_generation ? row.approved_generation : null,
  }));
}

experienceRoutes.get('/api/pets/:id/experience', async (c) => {
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  const notes = await currentNotes(c.env.DB, owned.id, owned.pet);
  const field = await c.env.DB.prepare(
    `SELECT f.source_thought_id, f.wording, f.published_generation FROM experience_field f
     JOIN experience_notes n ON n.source_thought_id = f.source_thought_id
     JOIN thoughts t ON t.id = n.source_thought_id
     WHERE f.token_id = ? AND f.publisher = ? AND f.published_generation = ?
       AND n.token_id = f.token_id AND n.status = 'active' AND n.memory_epoch = ?
       AND n.approved_generation = f.published_generation AND t.status = 'billed'
       AND t.debit_tx_hash IS NOT NULL AND t.erased_at IS NULL`,
  ).bind(owned.id, owned.pet.owner_id, owned.pet.transfer_generation, await memoryEpoch(c.env.DB, owned.id))
    .first<{ source_thought_id: string; wording: string; published_generation: number }>();
  return c.json({ tokenId: owned.id, generation: owned.pet.transfer_generation,
    notes: notes.map((row) => ({ id: row.source_thought_id, text: row.note_text,
      proposedField: `Worked on ${row.proposed_field}`, sourceReportId: row.source_report_id,
      at: row.created_at, approved: row.approved_generation !== null, sourceForm: row.source_form })),
    field: field === null ? null : { noteId: field.source_thought_id, wording: field.wording,
      sourceReportId: notes.find((row) => row.source_thought_id === field.source_thought_id)?.source_report_id ?? null },
  });
});

experienceRoutes.put('/api/pets/:id/experience/notes/:note/approval', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  const note = c.req.param('note');
  if (!TOKEN_ID.test(id) || !NOTE_ID.test(note)) return c.json({ code: 'bad_request' }, 400);
  const body = await c.req.json<{ approved?: unknown; generation?: unknown }>().catch(() => null);
  if (body === null || typeof body.approved !== 'boolean' || !Number.isSafeInteger(body.generation))
    return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (body.generation !== owned.pet.transfer_generation) return c.json({ code: 'stale_generation' }, 409);
  const epoch = await memoryEpoch(c.env.DB, id);
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE experience_notes SET approved_generation = ?
       WHERE source_thought_id = ? AND token_id = ? AND status = 'active' AND memory_epoch = ?
         AND EXISTS (SELECT 1 FROM thoughts t WHERE t.id = experience_notes.source_thought_id
           AND t.status = 'billed' AND t.debit_tx_hash IS NOT NULL AND t.erased_at IS NULL)`,
    ).bind(body.approved ? owned.pet.transfer_generation : null, note, id, epoch),
    ...(body.approved ? [] : [c.env.DB.prepare('DELETE FROM experience_field WHERE token_id = ? AND source_thought_id = ?')
      .bind(id, note)]),
  ]);
  if ((result[0]?.meta.changes ?? 0) === 0) return c.json({ code: 'no_note' }, 404);
  track('experience_note_approved', { approved: body.approved });
  await recordExperienceEvent(c.env, 'experience_note_approved', { approved: body.approved });
  return c.json({ noteId: note, approved: body.approved, generation: owned.pet.transfer_generation });
});

experienceRoutes.post('/api/pets/:id/experience/field', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  const body = await c.req.json<{ noteId?: unknown; generation?: unknown }>().catch(() => null);
  if (!TOKEN_ID.test(id) || body === null || typeof body.noteId !== 'string' || !NOTE_ID.test(body.noteId)
    || !Number.isSafeInteger(body.generation)) return c.json({ code: 'bad_request' }, 400);
  const owned = await ownedPet(c);
  if (owned instanceof Response) return owned;
  if (body.generation !== owned.pet.transfer_generation) return c.json({ code: 'stale_generation' }, 409);
  const epoch = await memoryEpoch(c.env.DB, id);
  const stillOwned = await ownedPet(c);
  if (stillOwned instanceof Response) return stillOwned;
  if (stillOwned.pet.transfer_generation !== owned.pet.transfer_generation)
    return c.json({ code: 'stale_generation' }, 409);
  // The INSERT reads the retained candidate in the same D1 statement that publishes it. The
  // browser cannot supply wording, and a clear/replacement before this write makes it a no-op.
  const written = await c.env.DB.prepare(
    `INSERT INTO experience_field (token_id, source_thought_id, wording, publisher, published_generation)
     SELECT n.token_id, n.source_thought_id, 'Worked on ' || n.proposed_field,
       ?, ? FROM experience_notes n JOIN thoughts t ON t.id = n.source_thought_id
     WHERE n.token_id = ? AND n.source_thought_id = ? AND n.status = 'active'
       AND n.memory_epoch = ? AND n.approved_generation = ?
       AND t.status = 'billed' AND t.debit_tx_hash IS NOT NULL AND t.erased_at IS NULL
     ON CONFLICT(token_id) DO UPDATE SET source_thought_id = excluded.source_thought_id,
       wording = excluded.wording, publisher = excluded.publisher,
       published_generation = excluded.published_generation`,
  ).bind(owned.pet.owner_id, owned.pet.transfer_generation, id, body.noteId, epoch,
    owned.pet.transfer_generation).run();
  if (written.meta.changes === 0) return c.json({ code: 'no_approved_note' }, 409);
  track('experience_field_published');
  await recordExperienceEvent(c.env, 'experience_field_published');
  return c.json({ noteId: body.noteId, published: true });
});

experienceRoutes.get('/api/pets/:id/work', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  try {
    const pet = await petView(c.env, id);
    if (pet === null) return c.json({ code: 'no_pet' }, 404);
    const counts = await experienceView(c.env, id);
    if (counts === null) return c.json({ code: 'no_pet' }, 404);
    const epoch = await memoryEpoch(c.env.DB, id);
    const [field, receipts] = await Promise.all([
      c.env.DB.prepare(
        `SELECT f.wording, n.source_report_id FROM experience_field f
         JOIN experience_notes n ON n.source_thought_id = f.source_thought_id
         JOIN thoughts t ON t.id = n.source_thought_id
         WHERE f.token_id = ? AND f.publisher = ? AND f.published_generation = ?
           AND n.token_id = f.token_id AND n.status = 'active' AND n.memory_epoch = ?
           AND n.approved_generation = f.published_generation AND t.status = 'billed'
           AND t.debit_tx_hash IS NOT NULL AND t.erased_at IS NULL`,
      ).bind(id, pet.owner_id, pet.transfer_generation, epoch)
        .first<{ wording: string; source_report_id: string }>(),
      c.env.DB.prepare(
        `SELECT id, receipt_token_id, debit_tx_hash, created_at, kind FROM thoughts
         WHERE status = 'billed' AND debit_tx_hash IS NOT NULL
           AND ((paying_token_id = ? AND completed_errand = 1)
             OR EXISTS (SELECT 1 FROM hires h WHERE h.answer_thought_id = thoughts.id
               AND h.worker_id = ? AND h.status = 'recorded'))
         ORDER BY created_at DESC, id DESC`,
      ).bind(id, id).all<{ id: string; receipt_token_id: string | null; debit_tx_hash: string; created_at: number; kind: string }>(),
    ]);
    return c.json({ tokenId: id, counts: { paidHires: counts.paid_hires,
      completedErrands: counts.completed_errands, countedSince: counts.counted_since },
      field: field === null ? null : { wording: field.wording, sourceReportId: field.source_report_id },
      receipts: receipts.results.map((row) => ({ thoughtId: row.id,
        tokenId: row.receipt_token_id, debitTxHash: row.debit_tx_hash,
        at: row.created_at, kind: row.kind })),
    });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

experienceRoutes.post('/api/experience/record-opened', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (body === null || Object.keys(body).sort().join(',') !== 'petId,playerId,tabId'
    || ![body.tabId, body.playerId, body.petId].every((id) => typeof id === 'string' && OPAQUE_ID.test(id)))
    return c.json({ code: 'bad_request' }, 400);
  await recordExperienceEvent(c.env, 'experience_record_opened',
    { ids: { tabId: body.tabId as string, playerId: body.playerId as string, petId: body.petId as string } });
  track('experience_record_opened');
  return c.body(null, 204);
});
