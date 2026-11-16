// OneSpends — sync merge logic (pure, no browser APIs; unit-tested in Node).
//
// Model: every record carries updatedAt (ms). The server keeps an append-only
// version log per user and accepts a write only when its updatedAt beats the
// record's latest version (last-write-wins). Deletes travel as tombstones.
// These two planners decide, deterministically, what to push and what to
// apply — the engine in js/sync.js just executes the plans against
// IndexedDB + fetch.

/** Effective write time of a local record (legacy rows predate updatedAt). */
export function recordUpdatedAt(rec) {
  if (rec && Number.isFinite(rec.updatedAt)) return rec.updatedAt;
  if (rec && Number.isFinite(rec.createdAt)) return rec.createdAt;
  return 0;
}

/** The exact shape that goes on the wire / is stored server-side. */
export function wireRecord(rec) {
  const updatedAt = recordUpdatedAt(rec);
  return {
    id: rec.id,
    vendor: rec.vendor,
    amount: rec.amount,
    currency: rec.currency,
    date: rec.date,
    category: rec.category,
    note: rec.note ?? "",
    source: rec.source ?? "manual",
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : updatedAt,
    updatedAt,
  };
}

/**
 * What to PUT: local records whose updatedAt differs from the last synced
 * value (syncedMap), plus tombstones not yet acknowledged. Applying the
 * returned list successfully means syncedMap[id] = updatedAt for each.
 */
export function planPush(localRecords, tombstones, syncedMap) {
  const out = [];
  for (const rec of localRecords) {
    const u = recordUpdatedAt(rec);
    if (syncedMap[rec.id] !== u) out.push(wireRecord(rec));
  }
  for (const t of tombstones || []) {
    if (syncedMap[t.id] !== t.updatedAt) {
      out.push({ id: t.id, updatedAt: t.updatedAt, deleted: true });
    }
  }
  return out;
}

/**
 * What to apply locally from a pulled page of remote versions (already in
 * server seq order). LWW per record: a remote version wins only when its
 * updatedAt is strictly newer than the local copy. A tombstone deletes the
 * local copy when the copy is not newer; a NEWER local copy survives and
 * will be re-pushed by the next planPush (resurrection by LWW, intended).
 * Returns { upserts: [wireRecord...], deletes: [id...] }.
 */
export function planApply(localById, remoteRows) {
  const upserts = [];
  const deletes = [];
  for (const row of remoteRows || []) {
    const local = localById.get(row.recordId);
    const localU = local ? recordUpdatedAt(local) : -1;
    if (row.deleted) {
      if (local && localU <= row.updatedAt) deletes.push(row.recordId);
    } else if (row.data && row.updatedAt > localU) {
      upserts.push(row.data);
    }
  }
  return { upserts, deletes };
}
