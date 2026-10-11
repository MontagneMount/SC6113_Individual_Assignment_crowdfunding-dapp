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

const postJson = (path, data) =>
  request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });

export const api = {
  config: () => request("/api/config"),
  stats: () => request("/api/stats"),
  campaigns: (params = {}) => request(`/api/campaigns?${new URLSearchParams(params)}`),
  campaign: (id) => request(`/api/campaigns/${encodeURIComponent(id)}`),
  user: (address) => request(`/api/users/${encodeURIComponent(address)}`),
  saveDetails: (id, formData) => request(`/api/campaigns/${encodeURIComponent(id)}/metadata`, { method: "POST", body: formData }),
  sync: () => postJson("/api/sync"),
  devArtifact: () => request("/api/dev/artifact"),
  saveDeployment: (txHash) => postJson("/api/dev/deployment", { txHash }),
};

let configPromise = null;

/** Contract address, ABI, chain info and limits (loaded once per page). */
export function getConfig() {
  configPromise ??= api.config();
  return configPromise;
}
