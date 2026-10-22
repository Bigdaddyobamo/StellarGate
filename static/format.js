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

export function buildSep7Uri({ destination, amount, assetCode, assetIssuer, memo, memoType, networkPassphrase } = {}) {
  const params = new URLSearchParams();
  if (destination) params.set("destination", destination);
  if (amount !== undefined && amount !== null && amount !== "") params.set("amount", String(amount));
  if (assetCode) params.set("asset_code", assetCode);
  if (assetIssuer) params.set("asset_issuer", assetIssuer);
  if (memo) params.set("memo", memo);
  if (memoType) params.set("memo_type", memoType);
  if (networkPassphrase) params.set("network_passphrase", networkPassphrase);
  const qs = params.toString();
  return qs ? `web+stellar:pay?${qs}` : "web+stellar:pay";
}

export function explorerTx(hash, network = "testnet") {
  if (!hash) return "";
  const base = network === "public" || network === "mainnet"
    ? "https://stellar.expert/explorer/public/tx/"
    : "https://stellar.expert/explorer/testnet/tx/";
  return `${base}${encodeURIComponent(hash)}`;
}

// Asset code for a payment row, with a dash fallback when the list
// response does not carry one. Pure and DOM-free.
export function assetLabel(payment) {
  if (!payment || typeof payment !== "object") return "—";
  const code = payment.asset_code ?? payment.assetCode ?? payment.asset;
  if (code === null || code === undefined) return "—";
  const s = String(code).trim();
  return s === "" ? "—" : s;
}

// Webhook delivery status for a payment row.
// Returns "delivered" | "failing" | "none" when the list response carries
// webhook status, and "unknown" when it does not (neutral fallback).
export function webhookStatus(payment) {
  if (!payment || typeof payment !== "object") return "unknown";
  const raw = payment.webhook_status ?? payment.webhookStatus;
  if (raw === null || raw === undefined || raw === "") return "unknown";
  const s = String(raw).toLowerCase();
  if (["delivered", "success", "succeeded", "ok"].includes(s)) return "delivered";
  if (["failing", "failed", "error", "retrying", "pending"].includes(s)) return "failing";
  if (["none", "not_configured", "disabled", "skipped"].includes(s)) return "none";
  return "unknown";
}

// Badge class for a webhook status value; reuses pillClass so the
// dashboard stays visually consistent.
export function webhookPillClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "delivered") return pillClass("delivered");
  if (s === "failing") return pillClass("failed");
  return "pill";
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
