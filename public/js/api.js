// Calls to our own Flask backend.

async function request(path, options = {}) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON (e.g. a network error page)
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const postJson = (path, data, options = {}) =>
  request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}), ...options });

// The admin's MetaMask sign-in, sent with every visitor-log request (see backend/visits.py).
const adminHeaders = (auth) => ({
  "X-Admin-Wallet": auth.wallet,
  "X-Admin-Issued-At": auth.issuedAt,
  "X-Admin-Signature": auth.signature,
});

export const api = {
  config: () => request("/api/config"),
  stats: () => request("/api/stats"),
  campaigns: (params = {}) => request(`/api/campaigns?${new URLSearchParams(params)}`),
  campaign: (id) => request(`/api/campaigns/${encodeURIComponent(id)}`),
  user: (address) => request(`/api/users/${encodeURIComponent(address)}`),
  saveDetails: (id, formData) => request(`/api/campaigns/${encodeURIComponent(id)}/metadata`, { method: "POST", body: formData }),
  sync: () => postJson("/api/sync"),
  recordVisit: (visit) => postJson("/api/visits", visit, { keepalive: true }), // finishes even if the user leaves the page
  adminVisits: (auth, filters) => request(`/api/admin/visits?${new URLSearchParams(filters)}`, { headers: adminHeaders(auth) }),
  deleteVisit: (auth, id) =>
    request(`/api/admin/visits/${encodeURIComponent(id)}`, { method: "DELETE", headers: adminHeaders(auth) }),
  deleteVisits: (auth, filters) =>
    request(`/api/admin/visits?${new URLSearchParams(filters)}`, { method: "DELETE", headers: adminHeaders(auth) }),
  devArtifact: () => request("/api/dev/artifact"),
  saveDeployment: (txHash) => postJson("/api/dev/deployment", { txHash }),
};

let configPromise = null;

/** Contract address, ABI, chain info and limits (loaded once per page). */
export function getConfig() {
  configPromise ??= api.config();
  return configPromise;
}
