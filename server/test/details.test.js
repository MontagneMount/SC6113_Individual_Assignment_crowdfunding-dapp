// Backend tests for campaign-details validation and creator signatures.
// Run with: npm run test:server
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "ethers";
import { buildDetailsMessage, normalizeDescription } from "../../public/js/shared/constants.js";
import { InputError, parseCampaignId, recoverDetailsSigner, validateDetailsInput } from "../details.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CHAIN_ID = 11155111;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

// Hash text the same way the browser does (Web Crypto), to prove both sides agree.
async function browserSha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/** Signs details exactly like public/js/contract.js does in the browser. */
async function signDetails(wallet, { campaignId = 1, category = "Games", description = "A cooperative board game.", issuedAt = new Date().toISOString() } = {}) {
  const text = normalizeDescription(description);
  const message = buildDetailsMessage({
    campaignId,
    contractAddress: CONTRACT,
    chainId: CHAIN_ID,
    category,
    descriptionSha256: await browserSha256(text),
    imageSha256: null,
    issuedAt,
  });
  return { category, description, issuedAt, signature: await wallet.signMessage(message) };
}

const recover = (input, campaignId = 1) =>
  recoverDetailsSigner({ campaignId, contractAddress: CONTRACT, chainId: CHAIN_ID, input, imageSha256: null });

describe("creator signatures", () => {
  it("recovers the address that signed the details", async () => {
    const creator = Wallet.createRandom();
    const input = validateDetailsInput(await signDetails(creator), undefined);
    assert.equal(recover(input), creator.address);
  });

  it("detects a description that was changed after signing", async () => {
    const creator = Wallet.createRandom();
    const signed = await signDetails(creator);
    const tampered = validateDetailsInput({ ...signed, description: "Something else entirely." }, undefined);
    assert.notEqual(recover(tampered), creator.address);
  });

  it("does not accept a signature made for another campaign", async () => {
    const creator = Wallet.createRandom();
    const input = validateDetailsInput(await signDetails(creator, { campaignId: 1 }), undefined);
    assert.notEqual(recover(input, 2), creator.address);
  });

  it("treats browser line breaks (\\r\\n) the same as \\n", async () => {
    const creator = Wallet.createRandom();
    const signed = await signDetails(creator, { description: "Line one\nLine two" });
    const fromForm = validateDetailsInput({ ...signed, description: "Line one\r\nLine two" }, undefined);
    assert.equal(recover(fromForm), creator.address);
  });
});

describe("input validation", () => {
  const valid = () => ({
    category: "Games",
    description: "Hello",
    issuedAt: new Date().toISOString(),
    signature: `0x${"ab".repeat(65)}`,
  });

  it("accepts a well-formed request", () => {
    assert.equal(validateDetailsInput(valid(), undefined).description, "Hello");
  });

  for (const [name, patch, expected] of [
    ["an unknown category", { category: "Crypto" }, /category/],
    ["an empty description", { description: "   " }, /required/],
    ["a description over 2000 characters", { description: "x".repeat(2001) }, /at most/],
    ["an expired signing time", { issuedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }, /expired/],
    ["a malformed signing time", { issuedAt: "yesterday" }, /signing time/],
    ["an impossible ISO date", { issuedAt: "2026-99-99T99:99:99.999Z" }, /signing time/],
    ["a date normalised into another day", { issuedAt: "2026-02-30T00:00:00.000Z" }, /signing time/],
    ["a malformed signature", { signature: "0x1234" }, /signature/],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => validateDetailsInput({ ...valid(), ...patch }, undefined), (err) => err instanceof InputError && expected.test(err.message));
    });
  }

  it("accepts a real PNG and rejects a file that only claims to be one", () => {
    assert.ok(validateDetailsInput(valid(), { mimetype: "image/png", buffer: PNG_BYTES }));
    const fake = { mimetype: "image/png", buffer: Buffer.from("<script>alert(1)</script>") };
    assert.throws(() => validateDetailsInput(valid(), fake), /PNG, JPEG or WebP/);
  });

  it("only accepts positive whole campaign ids", () => {
    assert.equal(parseCampaignId("7"), 7);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) assert.throws(() => parseCampaignId(bad), InputError);
  });
});
