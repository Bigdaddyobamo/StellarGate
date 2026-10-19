// DOM-free formatting helpers shared by the dashboard and node --test.

export function pillClass(status) {
  switch (status) {
    case 'success':
      return 'pill pill-success';
    case 'pending':
      return 'pill pill-pending';
    case 'failed':
      return 'pill pill-failed';
    default:
      return 'pill';
  }
}

export function formatAmount(amount, asset) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const fixed = n.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
  return asset ? `${fixed} ${asset}` : fixed;
}

export function explorerTx(hash) {
  if (!hash) return '';
  return `https://stellar.expert/explorer/public/tx/${hash}`;
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const then = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(then)) return '—';
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function countdown(expiresAt, now = Date.now()) {
  if (!expiresAt) return '—';
  const end = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(end)) return '—';
  const remaining = Math.max(0, Math.floor((end - now) / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(Date.parse(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function buildSep7Uri({ destination, amount, asset, memo, memoType } = {}) {
  const params = new URLSearchParams();
  if (destination) params.set('destination', destination);
  if (amount !== undefined && amount !== null) params.set('amount', String(amount));
  if (asset) params.set('asset_code', asset);
  if (memo) params.set('memo', memo);
  if (memoType) params.set('memo_type', memoType);
  return `web+stellar:pay?${params.toString()}`;
}

export function filterPayments(payments, { status, asset, query } = {}) {
  if (!Array.isArray(payments)) return [];
  const q = query ? String(query).toLowerCase() : '';
  return payments.filter((p) => {
    if (status && p.status !== status) return false;
    if (asset && p.asset !== asset) return false;
    if (q) {
      const hay = `${p.id ?? ''} ${p.destination ?? ''} ${p.memo ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Column definitions used by the dashboard table and CSV export.
export const CSV_COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'created_at', label: 'Created' },
  { key: 'destination', label: 'Destination' },
  { key: 'amount', label: 'Amount' },
  { key: 'asset', label: 'Asset' },
  { key: 'status', label: 'Status' },
  { key: 'memo', label: 'Memo' },
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows, columns = CSV_COLUMNS) {
  const cols = Array.isArray(columns) && columns.length ? columns : CSV_COLUMNS;
  const header = cols.map((c) => csvEscape(c.label ?? c.key)).join(',');
  const body = (Array.isArray(rows) ? rows : []).map((row) =>
    cols.map((c) => csvEscape(row ? row[c.key] : '')).join(',')
  );
  return [header, ...body].join('\n');
}

export function buildListQuery({ status, asset, cursor, limit } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (asset) params.set('asset', asset);
  if (cursor) params.set('cursor', cursor);
  if (limit !== undefined && limit !== null) params.set('limit', String(limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function shortId(id, length = 8) {
  if (id === null || id === undefined) return '';
  const s = String(id);
  if (s.length <= length) return s;
  return `${s.slice(0, length)}…`;
}
