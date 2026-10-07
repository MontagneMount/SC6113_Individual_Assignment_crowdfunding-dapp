import { InputError } from "./details.js";

const conflict = () => new InputError("Details changed or this signature was already used. Please sign again.", 409);

// Compare-and-set protects the version AND image reference read by the request.
// A concurrent writer causes a conflict rather than overwriting its newer state.
export async function saveDetailsVersion(collection, campaignId, existing, details) {
  if (existing && existing.issuedAt >= details.issuedAt) throw conflict();
  if (!existing) {
    try {
      await collection.insertOne({ _id: campaignId, ...details });
    } catch (err) {
      if (err.code === 11000) throw conflict();
      throw err;
    }
    return;
  }
  const result = await collection.updateOne(
    { _id: campaignId, issuedAt: existing.issuedAt },
    { $set: details },
  );
  if (result.matchedCount !== 1) throw conflict();
}
