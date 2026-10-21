/* Session store: the API-key storage rules from #252.
 *
 * The merchant's API key lives in the browser only. "Remember me" keeps it in
 * localStorage (survives reloads); otherwise it lives in sessionStorage (tab
 * only). Signing out clears both stores. A saved key also expires after a TTL
 * so a forgotten tab does not hold a live credential forever.
 *
 * DOM-free so it runs under `node --test` (issue #723).
 */

export const KEY_NAME = "stellargate.apiKey";
export const KEY_SAVED_AT = "stellargate.apiKeySavedAt";
export const SESSION_TTL_MS = 30 * 60 * 1000;

const KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A minimal in-memory Storage stand-in used when no storage area is supplied. */
export function memoryStorage() {
  const data = Object.create(null);
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem(k, v) {
      data[k] = String(v);
    },
    removeItem(k) {
      delete data[k];
    },
  };
}

function safeGet(area, key) {
  try {
    return area && typeof area.getItem === "function" ? area.getItem(key) : null;
  } catch (e) {
    return null;
  }
}

function safeSet(area, key, value) {
  try {
    if (area && typeof area.setItem === "function") {
      area.setItem(key, value);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function safeRemove(area, key) {
  try {
    if (area && typeof area.removeItem === "function") area.removeItem(key);
  } catch (e) {
    /* ignore */
  }
}

/** Build a merchant session store over a session and local storage area. */
export function createSessionStore(opts = {}) {
  const session = opts.session || memoryStorage();
  const local = opts.local || memoryStorage();
  const now = opts.now || Date.now;

  function expired(savedAt) {
    if (!savedAt) return false;
    const at = Number(savedAt);
    if (!Number.isFinite(at)) return false;
    return now() - at > KEY_TTL_MS;
  }

  function read() {
    const key = safeGet(session, KEY_NAME) || safeGet(local, KEY_NAME);
    if (!key) return null;
    const savedAt = safeGet(session, KEY_SAVED_AT) || safeGet(local, KEY_SAVED_AT);
    if (expired(savedAt)) {
      clear();
      return null;
    }
    return key;
  }

  function write(key, persist) {
    if (!key || String(key).length === 0) return false;
    clear();
    const target = persist ? local : session;
    const other = persist ? session : local;
    if (!safeSet(target, KEY_NAME, key)) return false;
    safeSet(target, KEY_SAVED_AT, String(now()));
    safeRemove(other, KEY_NAME);
    safeRemove(other, KEY_SAVED_AT);
    return true;
  }

  function save(key, persist) {
    return write(key, persist);
  }

  function clear() {
    safeRemove(session, KEY_NAME);
    safeRemove(session, KEY_SAVED_AT);
    safeRemove(local, KEY_NAME);
    safeRemove(local, KEY_SAVED_AT);
  }

  function savedAt() {
    const raw = safeGet(session, KEY_SAVED_AT) || safeGet(local, KEY_SAVED_AT);
    if (raw === null || raw === undefined || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function expiresAt() {
    const when = savedAt();
    return when === null ? null : when + SESSION_TTL_MS;
  }

  function has() {
    return read() !== null;
  }

  function describe() {
    const key = read();
    if (!key) return null;
    return {
      length: key.length,
      prefix: key.slice(0, 8),
      suffix: key.slice(-4),
    };
  }

  return { read, write, save, clear, savedAt, expiresAt, has, describe };
}
