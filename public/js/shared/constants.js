// Rules the browser shares with the Flask backend: backend/constants.py mirrors this file,
// and tests/test_shared_with_browser.py checks that both validate input and build the signed
// message in exactly the same way. No imports on purpose.

export const SEPOLIA = {
  chainId: 11155111,
  chainIdHex: "0xaa36a7",
  name: "Sepolia",
  explorerUrl: "https://sepolia.etherscan.io",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  currency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
};

export const CATEGORIES = [
  "Technology",
  "Arts & Design",
  "Games",
  "Community",
  "Sports",
  "Education",
  "Environment",
  "Other",
];

export const LIMITS = {
  titleMaxBytes: 80, // must match MAX_TITLE_LENGTH in Crowdfunding.sol
  descriptionMaxChars: 2000,
  imageMaxBytes: 2 * 1024 * 1024,
  imageTypes: ["image/png", "image/jpeg", "image/webp"],
  signatureMaxAgeMs: 10 * 60 * 1000,
  minDurationSeconds: 60, // must match MIN_DURATION in Crowdfunding.sol
  maxDurationSeconds: 90 * 24 * 60 * 60, // must match MAX_DURATION in Crowdfunding.sol
  visitRetentionDays: 30, // visitor-log records are deleted automatically after this
};

// Browsers send form text with "\r\n" line breaks, so normalise before hashing.
export function normalizeDescription(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/** The exact text a creator signs in MetaMask before campaign details are saved. */
export function buildDetailsMessage({
  campaignId,
  contractAddress,
  chainId,
  category,
  descriptionSha256,
  imageSha256,
  issuedAt,
}) {
  return [
    "CampusFund: save campaign details",
    "",
    `Campaign ID: ${campaignId}`,
    `Contract: ${contractAddress}`,
    `Chain ID: ${chainId}`,
    `Category: ${category}`,
    `Description SHA-256: ${descriptionSha256}`,
    `New cover image SHA-256: ${imageSha256 ?? "none"}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}

/** The exact text the admin signs in MetaMask to open the visitor log. */
export function buildAdminMessage({ wallet, contractAddress, chainId, issuedAt }) {
  return [
    "CampusFund: admin sign-in",
    "",
    `Lets this wallet view and delete visit records for ${LIMITS.signatureMaxAgeMs / 60_000} minutes.`,
    "",
    `Wallet: ${wallet}`,
    `Contract: ${contractAddress}`,
    `Chain ID: ${chainId}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}
