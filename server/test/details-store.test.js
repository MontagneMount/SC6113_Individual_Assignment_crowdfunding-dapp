import assert from "node:assert/strict";
import { test } from "node:test";
import { saveDetailsVersion } from "../details-store.js";

// Atomic in-memory collection double; these are unit tests, not MongoDB integration tests.
function collection(initial = null) {
  let row = initial && { ...initial };
  return {
    read: () => row && { ...row },
    async insertOne(doc) {
      if (row) throw Object.assign(new Error("Duplicate key"), { code: 11000 });
      row = { ...doc };
    },
    async updateOne(filter, update) {
      if (!row || row._id !== filter._id || row.issuedAt !== filter.issuedAt) return { matchedCount: 0 };
      row = { ...row, ...update.$set };
      return { matchedCount: 1 };
    },
  };
}
const base = { _id: 1, issuedAt: "2026-10-06T00:00:00.000Z", imageId: "original" };
const newer = { issuedAt: "2026-10-06T00:00:02.000Z", imageId: "new" };
const older = { issuedAt: "2026-10-06T00:00:01.000Z", imageId: "old" };
const isConflict = (err) => err.status === 409;

test("rejects an equal-time replay and preserves the saved record", async () => {
  const db = collection(base);
  await assert.rejects(saveDetailsVersion(db, 1, db.read(), base), isConflict);
  assert.deepEqual(db.read(), base);
});
test("a delayed older writer cannot overwrite a newer version or image", async () => {
  const db = collection(base);
  const snapshot = db.read();
  await saveDetailsVersion(db, 1, snapshot, newer);
  await assert.rejects(saveDetailsVersion(db, 1, snapshot, older), isConflict);
  assert.equal(db.read().imageId, "new");
});
test("concurrent updates from the same snapshot have one winner", async () => {
  const db = collection(base);
  const results = await Promise.allSettled([
    saveDetailsVersion(db, 1, base, older), saveDetailsVersion(db, 1, base, newer),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
});
test("concurrent first saves cannot replace the winning document", async () => {
  const db = collection();
  const results = await Promise.allSettled([
    saveDetailsVersion(db, 1, null, newer), saveDetailsVersion(db, 1, null, older),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(db.read().issuedAt, newer.issuedAt);
});
test("a fresh snapshot can save a newer version after a conflict", async () => {
  const db = collection(base);
  await saveDetailsVersion(db, 1, db.read(), older);
  await saveDetailsVersion(db, 1, db.read(), newer);
  assert.equal(db.read().issuedAt, newer.issuedAt);
});
test("database failures are propagated rather than reported as replay", async () => {
  const failure = new Error("Connection interrupted");
  await assert.rejects(saveDetailsVersion({ insertOne: async () => { throw failure; } }, 1, null, newer), (e) => e === failure);
});
