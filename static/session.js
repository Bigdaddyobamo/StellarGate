/* Session store: the API-key storage rules from #252.
 *
 * The merchant's API key lives in the browser only. "Remember me" keeps it in
 * localStorage (survives reloads); otherwise it lives in sessionStorage (tab
 * only). Signing out clears both stores. A saved key also expires after a TTL
 * so a forgotten tab does not hold a live credential forever.
 *
 * DOM-free so it runs under `node --test` (issue #723).
 */

/** localStorage/sessionStorage key holding the API key. */
export var KEY_NAME = "stellargate.apiKey";

/** Storage key recording when the API key was saved (for the TTL check). */
export var KEY_SAVED_AT = "stellargate.apiKeySavedAt";

/** How long a remembered key stays valid, in milliseconds (7 days). */
var KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A tiny Map-backed Storage stand-in, used when neither sessionStorage nor
 * localStorage is available (private mode, tests, non-browser hosts).
 */
export function memoryStorage() {
  var map = new Map();
  return {
    getItem: function (key) { return map.has(key) ? map.get(key) : null; },
    setItem: function (key, value) { map.set(key, String(value)); },
    removeItem: function (key) { map.delete(key); },
  };
}

/** Read a key, swallowing storage errors (quota, disabled storage). */
function safeGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch (e) {
    return null;
  }
}

/** Write a key, swallowing storage errors. */
function safeSet(storage, key, value) {
  try {
    if (storage) storage.setItem(key, value);
  } catch (e) {
    /* non-fatal */
  }
}

/** Remove a key, swallowing storage errors. */
function safeRemove(storage, key) {
  try {
    if (storage) storage.removeItem(key);
  } catch (e) {
    /* non-fatal */
  }
}

/**
 * Create a session store over the given storages.
 *
 * @param {{session?: Storage, local?: Storage}} [opts]
 * @returns {{read: Function, save: Function, clear: Function}}
 */
export function createSessionStore(opts) {
  opts = opts || {};
  var session = opts.session || memoryStorage();
  var local = opts.local || memoryStorage();

  function expired(savedAt) {
    if (!savedAt) return false;
    var at = Number(savedAt);
    if (!isFinite(at)) return false;
    return Date.now() - at > KEY_TTL_MS;
  }

  /** Return the stored API key, or null if absent or expired. */
  function read() {
    var key = safeGet(session, KEY_NAME) || safeGet(local, KEY_NAME);
    if (!key) return null;
    var savedAt = safeGet(session, KEY_SAVED_AT) || safeGet(local, KEY_SAVED_AT);
    if (expired(savedAt)) {
      clear();
      return null;
    }
    return key;
  }

  /**
   * Persist the API key. `remember` selects localStorage (survives reloads);
   * otherwise sessionStorage (tab only). The other store is cleared so a key
   * never lingers in both places.
   */
  function save(key, remember) {
    clear();
    if (!key) return;
    var target = remember ? local : session;
    var other = remember ? session : local;
    safeSet(target, KEY_NAME, key);
    safeSet(target, KEY_SAVED_AT, String(Date.now()));
    safeRemove(other, KEY_NAME);
    safeRemove(other, KEY_SAVED_AT);
  }

  /** Remove the API key from both stores. */
  function clear() {
    safeRemove(session, KEY_NAME);
    safeRemove(session, KEY_SAVED_AT);
    safeRemove(local, KEY_NAME);
    safeRemove(local, KEY_SAVED_AT);
  }

  return { read: read, save: save, clear: clear };
}
