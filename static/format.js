// Shared formatting helpers for the merchant dashboard.
//
// This module is imported directly by the browser as an ES module
// (`static/dashboard.js`), so every export here must be a real binding.
// Keep the surface small and dependency-free.

export function fmtTime(ts) {
  if (ts === null || ts === undefined || ts === "") return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function formatAmount(amount, asset) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const fixed = n.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return asset ? `${fixed} ${asset}` : fixed;
}

export function relativeTime(ts, now = Date.now()) {
  if (ts === null || ts === undefined || ts === "") return "—";
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.round((now - then) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${suffix}`;
  return `${Math.round(abs / 86400)}d ${suffix}`;
}

export function countdown(ts, now = Date.now()) {
  if (ts === null || ts === undefined || ts === "") return "—";
  const target = new Date(ts).getTime();
  if (Number.isNaN(target)) return "—";
  const diff = Math.round((target - now) / 1000);
  if (diff <= 0) return "expired";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}

export function pillClass(status) {
  const s = String(status || "").toLowerCase();
  if (["paid", "succeeded", "success", "delivered", "confirmed"].includes(s)) return "pill pill-ok";
  if (["pending", "processing", "created", "awaiting_payment"].includes(s)) return "pill pill-warn";
  if (["failed", "expired", "canceled", "cancelled", "error"].includes(s)) return "pill pill-bad";
  return "pill";
}

export function buildSep7Uri(payment = {}) {
  const p = payment && typeof payment === "object" ? payment : {};
  const destination = p.destination ?? p.destination_address ?? "";
  const amount = p.amount ?? "";
  const assetCode = p.asset_code ?? p.assetCode ?? p.asset ?? "";
  const assetIssuer = p.asset_issuer ?? p.assetIssuer ?? "";
  const memo = p.memo ?? "";
  const memoType = p.memo_type ?? p.memoType ?? inferSep7MemoType(memo);
  const networkPassphrase = p.network_passphrase ?? p.networkPassphrase ?? "";

  const params = new URLSearchParams();
  if (destination) params.set("destination", String(destination));
  if (amount !== undefined && amount !== null && amount !== "") {
    params.set("amount", String(amount));
  }
  if (assetCode && String(assetCode).trim() && String(assetCode).toUpperCase() !== "XLM") {
    params.set("asset_code", String(assetCode));
    if (assetIssuer) params.set("asset_issuer", String(assetIssuer));
  }
  if (memo !== undefined && memo !== null && memo !== "") {
    params.set("memo", String(memo));
    if (memoType) params.set("memo_type", String(memoType));
  }
  if (networkPassphrase) params.set("network_passphrase", String(networkPassphrase));
  const qs = params.toString();
  return qs ? `web+stellar:pay?${qs}` : "web+stellar:pay";
}

function inferSep7MemoType(memo) {
  if (memo === null || memo === undefined || memo === "") return "";
  const value = String(memo).trim();
  if (/^-?\d+$/.test(value)) return "id";
  return "text";
}

export function explorerTx(hash, network = "testnet") {
  if (!hash) return "";
  const base = network === "public" || network === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";
  return `${base}${encodeURIComponent(hash)}`;
}

// Shorten a long identifier (tx hash, payment id, ...) for display.
export function shortId(id, head = 6, tail = 6) {
  if (id === null || id === undefined) return "—";
  const s = String(id);
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Build a query string for the list endpoints from a filter object.
// Empty / null / undefined values are omitted; arrays are repeated keys.
export function buildListQuery(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === null || v === undefined || v === "") continue;
        params.append(key, String(v));
      }
      continue;
    }
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// Column definitions used when exporting list rows to CSV.
export const CSV_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "status", label: "Status" },
  { key: "amount", label: "Amount" },
  { key: "asset", label: "Asset" },
  { key: "created_at", label: "Created" },
];

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Serialise rows to CSV using CSV_COLUMNS (or an explicit column list).
export function toCsv(rows, columns = CSV_COLUMNS) {
  const cols = columns && columns.length ? columns : CSV_COLUMNS;
  const header = cols.map((c) => csvEscape(c.label ?? c.key)).join(",");
  const lines = (rows || []).map((row) =>
    cols.map((c) => csvEscape(row ? row[c.key] : "")).join(",")
  );
  return [header, ...lines].join("\n");
}
