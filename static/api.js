// API client for the StellarGate dashboard.
//
// Every request goes through `request()`, which owns the fetch call, the
// bearer auth header and the error handling. The API key is only ever sent
// in the `Authorization` header — never in a URL, a log line or the console.
// All paths are absolute `/v1/...` paths so the module works regardless of
// the page the dashboard is served from.
//
// For local frontend development without Postgres/Horizon/gateway, run
// `node scripts/mock-api.mjs` (see docs/dashboard-dev.md). It serves
// `static/` plus canned JSON for `/v1/payments`, the summary, webhooks,
// `/ready` and `/`. The mock ignores the bearer header entirely, so no API
// key is ever needed — or logged — while developing.

const API_BASE = "/v1";

/**
 * Perform an authenticated request against the gateway API.
 *
 * @param {string} path absolute API path, e.g. `/payments`
 * @param {object} [options]
 * @param {string} [options.method] HTTP method, defaults to GET
 * @param {string} [options.apiKey] merchant API key for the bearer header
 * @param {object} [options.body] JSON-serialisable request body
 * @param {AbortSignal} [options.signal] abort signal for cancellation
 * @returns {Promise<any>} parsed JSON response, or null for empty bodies
 */
export async function request(path, options = {}) {
  const { method = "GET", apiKey, body, signal } = options;
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload && (payload.error || payload.message) ? `: ${payload.error || payload.message}` : "";
    } catch {
      // Non-JSON error body; fall back to the status text below.
    }
    const error = new Error(`${response.status} ${response.statusText}${detail}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * List payments, optionally filtered and paginated.
 *
 * @param {object} [params]
 * @param {string} [params.status] filter by payment status
 * @param {string} [params.search] memo or payment ID search term
 * @param {string} [params.createdAfter] ISO date lower bound
 * @param {string} [params.createdBefore] ISO date upper bound
 * @param {number} [params.limit] page size
 * @param {number} [params.offset] pagination offset
 * @param {string} [params.apiKey] merchant API key
 * @param {AbortSignal} [params.signal] abort signal
 * @returns {Promise<any>}
 */
export async function listPayments(params = {}) {
  const { apiKey, signal, ...query } = params;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return request(`/payments${qs ? `?${qs}` : ""}`, { apiKey, signal });
}

/**
 * Fetch a single payment by ID.
 *
 * @param {string} id payment ID
 * @param {object} [options]
 * @param {string} [options.apiKey] merchant API key
 * @param {AbortSignal} [options.signal] abort signal
 * @returns {Promise<any>}
 */
export async function getPayment(id, options = {}) {
  return request(`/payments/${encodeURIComponent(id)}`, options);
}

/**
 * List webhook deliveries for a payment.
 *
 * @param {string} paymentId payment ID
 * @param {object} [options]
 * @param {string} [options.apiKey] merchant API key
 * @param {AbortSignal} [options.signal] abort signal
 * @returns {Promise<any>}
 */
export async function listDeliveries(paymentId, options = {}) {
  return request(`/payments/${encodeURIComponent(paymentId)}/deliveries`, options);
}

/**
 * Re-deliver a webhook for a payment.
 *
 * @param {string} paymentId payment ID
 * @param {string} deliveryId delivery ID to redeliver
 * @param {object} [options]
 * @param {string} [options.apiKey] merchant API key
 * @param {AbortSignal} [options.signal] abort signal
 * @returns {Promise<any>}
 */
export async function redeliver(paymentId, deliveryId, options = {}) {
  return request(
    `/payments/${encodeURIComponent(paymentId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
    { ...options, method: "POST" },
  );
}

/**
 * List the API keys belonging to a merchant.
 *
 * The response contains key metadata only (id, prefix, timestamps) — never
 * full key material. Nothing here logs the response body.
 *
 * @param {string} merchantId merchant ID
 * @param {object} [options]
 * @param {string} [options.apiKey] merchant API key
 * @param {AbortSignal} [options.signal] abort signal
 * @returns {Promise<any>}
 */
export async function listMerchantKeys(merchantId, options = {}) {
  return request(`/merchants/${encodeURIComponent(merchantId)}/keys`, options);
}

/**
 * Issue a new API key for a merchant.
 *
 * The response carries the full key material exactly once; callers must show
 * it to the operator and then discard it. It is never logged here.
 *
 * @param {string} merchantId merchant ID
 * @param {object} [options]
 * @param {string} [options.apiKey] merchant API key
 * @param {AbortSignal} [options.signal] abort signal
 * @returns {Promise<any>}
 */
export async function issueMerchantKey(merchantId, options = {}) {
  return request(`/merchants/${encodeURIComponent(merchantId)}/keys`, {
    ...options,
    method: "POST",
  });
}

/**
 * Revoke an API key belonging to a merchant.
 *
 * @param {string} merchantId merchant ID
 * @param {string} keyId API key ID to revoke
 * @param {object} [options]
 * @param {string} [options.apiKey] merchant API key
 * @param {AbortSignal} [options.signal] abort signal
 * @returns {Promise<any>}
 */
export async function revokeMerchantKey(merchantId, keyId, options = {}) {
  return request(
    `/merchants/${encodeURIComponent(merchantId)}/keys/${encodeURIComponent(keyId)}/revoke`,
    { ...options, method: "POST" },
  );
}
