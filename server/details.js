// Validation and signature checks for off-chain campaign details
// (description, category, cover image). Only the on-chain creator may save them.
import crypto from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { CATEGORIES, LIMITS, buildDetailsMessage, normalizeDescription } from "../public/js/shared/constants.js";

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// Check the real file bytes, not just the type the browser claims.
const FILE_SIGNATURES = {
  "image/png": (bytes) => bytes.length > 8 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/jpeg": (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/webp": (bytes) =>
    bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
};

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export function parseCampaignId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new InputError("Invalid campaign id.");
  return id;
}

export function validateDetailsInput(body, file) {
  const { category, issuedAt, signature } = body ?? {};
  const description = normalizeDescription(body?.description);

  if (!CATEGORIES.includes(category)) throw new InputError("Please choose a valid category.");
  if (description.length === 0) throw new InputError("Description is required.");
  if (description.length > LIMITS.descriptionMaxChars) {
    throw new InputError(`Description must be at most ${LIMITS.descriptionMaxChars} characters.`);
  }
  if (typeof issuedAt !== "string" || !ISO_TIME.test(issuedAt)) throw new InputError("Invalid signing time.");
  const issuedTime = Date.parse(issuedAt);
  if (!Number.isFinite(issuedTime) || new Date(issuedTime).toISOString() !== issuedAt) {
    throw new InputError("Invalid signing time.");
  }
  if (Math.abs(Date.now() - issuedTime) > LIMITS.signatureMaxAgeMs) {
    throw new InputError("This signature has expired. Please try again.");
  }
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) throw new InputError("Missing or invalid signature.");

  if (file) {
    const matchesType = LIMITS.imageTypes.includes(file.mimetype) && FILE_SIGNATURES[file.mimetype](file.buffer);
    if (!matchesType) throw new InputError("Cover image must be a PNG, JPEG or WebP file.");
  }

  return { category, description, issuedAt, signature };
}

/** Rebuilds the message the creator signed and returns the address that signed it. */
export function recoverDetailsSigner({ campaignId, contractAddress, chainId, input, imageSha256 }) {
  const message = buildDetailsMessage({
    campaignId,
    contractAddress,
    chainId,
    category: input.category,
    descriptionSha256: sha256Hex(Buffer.from(input.description, "utf8")),
    imageSha256,
    issuedAt: input.issuedAt,
  });
  try {
    return getAddress(verifyMessage(message, input.signature));
  } catch {
    throw new InputError("The signature could not be verified.");
  }
}
