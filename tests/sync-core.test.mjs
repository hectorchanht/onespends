// Node tests for js/sync-core.js — run: node tests/sync-core.test.mjs
import assert from "node:assert/strict";
import { recordUpdatedAt, wireRecord, planPush, planApply } from "../js/sync-core.js";

let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };

const rec = (id, amount, updatedAt, extra = {}) => ({
  id, vendor: "V" + id, amount, currency: "HKD", date: "2026-10-01",
  category: "餐飲", note: "", source: "manual", createdAt: updatedAt - 10, updatedAt, ...extra,
});

// legacy fallback: no updatedAt → createdAt
assert.equal(recordUpdatedAt({ createdAt: 42 }), 42);
assert.equal(wireRecord({ id: "x", vendor: "v", amount: 1, currency: "HKD", date: "2026-01-01", category: "其他", createdAt: 7 }).updatedAt, 7);
ok("legacy records fall back to createdAt");

// first-sign-in merge of disjoint sets: everything local is planned for push;
// remote-only records are planned as upserts; shared ids untouched when equal.
{
  const local = [rec("a", 10, 100), rec("b", 20, 100)];
  const push = planPush(local, [], {});
  assert.deepEqual(push.map((r) => r.id).sort(), ["a", "b"]);
  const localById = new Map(local.map((r) => [r.id, r]));
  const remote = [
    { recordId: "c", updatedAt: 90, deleted: false, data: rec("c", 30, 90) },
    { recordId: "a", updatedAt: 100, deleted: false, data: rec("a", 10, 100) }, // echo of own push
  ];
  const { upserts, deletes } = planApply(localById, remote);
  assert.deepEqual(upserts.map((r) => r.id), ["c"]);
  assert.deepEqual(deletes, []);
  ok("first-sign-in merge: disjoint sets merge, own echo is a no-op");
}

// nothing to push when syncedMap is current
{
  const local = [rec("a", 10, 100)];
  assert.deepEqual(planPush(local, [], { a: 100 }), []);
  assert.equal(planPush(local, [], { a: 99 }).length, 1);
  ok("planPush diffs against syncedMap");
}

// LWW conflict on the same record: newer remote overwrites; older remote does not
{
  const localById = new Map([["a", rec("a", 10, 100)]]);
  const newer = planApply(localById, [{ recordId: "a", updatedAt: 200, deleted: false, data: rec("a", 99, 200) }]);
  assert.equal(newer.upserts[0].amount, 99);
  const older = planApply(localById, [{ recordId: "a", updatedAt: 50, deleted: false, data: rec("a", 1, 50) }]);
  assert.equal(older.upserts.length, 0);
  ok("LWW conflict: strictly newer remote wins");
}

// tombstone propagation: deletes an older/equal local copy; a newer local copy survives
{
  const localById = new Map([["a", rec("a", 10, 100)], ["b", rec("b", 20, 300)]]);
  const { deletes } = planApply(localById, [
    { recordId: "a", updatedAt: 150, deleted: true },
    { recordId: "b", updatedAt: 150, deleted: true },
  ]);
  assert.deepEqual(deletes, ["a"]);
  ok("tombstone deletes older local copy, newer local copy survives");
}

// tombstones are planned for push until acknowledged via syncedMap
{
  const tombs = [{ id: "z", updatedAt: 500 }];
  assert.deepEqual(planPush([], tombs, {}), [{ id: "z", updatedAt: 500, deleted: true }]);
  assert.deepEqual(planPush([], tombs, { z: 500 }), []);
  ok("tombstone push + acknowledgement");
}

console.log(`\nsync-core.test.mjs: ${passed} checks passed`);
