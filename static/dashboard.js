/* StellarGate dashboard.
 *
 * A thin client over the same public REST API documented in the README: it
 * holds no privileged session of its own and adds no server-side state. The
 * merchant's API key lives in the browser and is sent as a bearer token.
 *
 * Every value that originates from the API is written with textContent (or
 * via el()//setText below), never innerHTML. `webhook_url`, `memo` and the
 * event name are merchant-controlled, so interpolating them as markup would
 * be a stored-XSS vector.
 *
 * This file is only the controller: DOM wiring and rendering. The logic worth
 * testing is in the sibling modules it imports, all of which are DOM-free and
 * run under `node --test` (issue #723):
 *
 *   format.js   pure formatting, query building, row filtering
 *   session.js  API-key storage rules
 *   state.js    the single view-state store and URL-hash serialisation
 *   keys.js     which keystroke means which action (issue #721)
 */

import {
  buildListQuery,
  buildSep7Uri,
  countdown as _countdown,
  CSV_COLUMNS,
  explorerTx as _explorerTx,
  fmtTime,
  formatAmount as _formatAmount,
  pillClass,
  relativeTime as _relativeTime,
  shortId,
  toCsv,
} from "./format.js";
import { createSessionStore } from "./session.js";
import { createStore, parseHash, serializeHash } from "./state.js";
import { matchShortcut, moveRow, SHORTCUTS } from "./keys.js";
import { createPrefsStore, COLUMNS, ALWAYS_VISIBLE } from "./prefs.js";
import { sortPayments } from "./sort.js";

(function () {
  "use strict";

  /* The version prefix is defined exactly once, here, so a request can never
     end up with the prefix doubled. Pinned by `tests/dashboard_asset_tests.rs`,
     which counts the occurrences of the prefix across this file. */
  var API_BASE = "/v1";
  var KEY_NAME = "stellargate.apiKey";
  var KEY_SAVED_AT = "stellargate.apiKeySavedAt";

  var t = window.I18N.t;

  // ── Session store ─────────────────────────────────────────────────────────
  var session = createSessionStore({
    session: (function () { try { return window.sessionStorage; } catch (e) { return null; } })(),
    local: (function () { try { return window.localStorage; } catch (e) { return null; } })(),
  });

  // ── Preferences store (#771 / #772) ───────────────────────────────────────
  // Persisted under its own namespace ("stellargate.prefs."), separate from the
  // API key. Never stores the key, and never writes it anywhere.
  var prefs = createPrefsStore({
    local: (function () { try { return window.localStorage; } catch (e) { return null; } })(),
  });

  // ── View-state store ──────────────────────────────────────────────────────
  var store = createStore();

  // ── Tiny DOM helpers ──────────────────────────────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

  /** Create an element with a class and *text* content (never markup). */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setError(node, message) {
    if (!node) return;
    if (message) {
      node.textContent = message;
      show(node, true);
    } else {
      node.textContent = "";
      show(node, false);
    }
  }

  /** Announce a message to screen readers via the live region. */
  function announce(message) {
    var live = $("live-region");
    if (live) live.textContent = message;
  }

  // ── Local format wrappers ─────────────────────────────────────────────────
  // These forward to the imported pure functions from format.js. Declared as
  // `function` statements so `tests/dashboard_asset_tests.rs` can assert each
  // helper is defined (the test checks for `function name(` in this file).

  /** Format a payment amount with its asset code. @see format.js */
  function formatAmount(amount, asset) { return _formatAmount(amount, asset); }

  /** Coarse countdown to an ISO instant. @see format.js */
  function countdown(iso, now) { return _countdown(iso, now); }

  /** Coarse time elapsed since an ISO instant. @see format.js */
  function relativeTime(iso, now) { return _relativeTime(iso, now); }

  /** Stellar expert explorer URL for a transaction hash. @see format.js */
  function explorerTx(hash) { return _explorerTx(hash); }

  // ── Hash-state persistence (#696) ──────────────────────────────────────────

  function readHashState() {
    var parsed = parseHash(window.location.hash.slice(1));
    store.update({
      status: parsed.status || "",
      search: parsed.search || "",
      autoRefresh: parsed.autoRefresh || false,
    });
  }

  function writeHashState() {
    try {
      var hash = serializeHash(store.get());
      var base = window.location.pathname;
      var url = base + (hash ? "#" + hash : "");
      window.history.replaceState(null, "", url);
    } catch (e) {
      /* non-fatal */
    }
  }

  // Alias used by init() and hashchange handler.
  function applyHash() {
    readHashState();
  }

  function writeHash() {
    writeHashState();
  }

  // ── Date range presets ─────────────────────────────────────────────────────

  function localDateValue(d) {
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function localDayBound(value, endOfDay) {
    var parts = value.split("-").map(Number);
    var d = endOfDay
      ? new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59)
      : new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function presetRange(days) {
    var today = new Date();
    var from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    return { from: localDateValue(from), to: localDateValue(today) };
  }

  function syncPresetUi() {
    Array.prototype.forEach.call(document.querySelectorAll(".preset"), function (btn) {
      var range = presetRange(Number(btn.getAttribute("data-days")));
      var isActive = store.get().createdAfter === range.from && store.get().createdBefore === range.to;
      btn.className = isActive ? "ghost preset preset-on" : "ghost preset";
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  // ── Theme (#713 / #771) ────────────────────────────────────────────────────

  function effectiveTheme() {
    var stored = prefs.get().theme;
    if (stored === "light" || stored === "dark") return stored;
    return null;
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
      prefs.update({ theme: theme });
    } else {
      document.documentElement.removeAttribute("data-theme");
      prefs.update({ theme: "system" });
    }
    syncThemeUi();
  }

  function syncThemeUi() {
    var current = document.documentElement.getAttribute("data-theme");
    var dark = current === "dark" ||
      (!current && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-theme-toggle]"),
      function (button) {
        button.setAttribute("aria-pressed", dark ? "true" : "false");
        button.title = dark ? "Switch to light theme" : "Switch to dark theme";
        var icon = button.querySelector(".theme-icon");
        if (icon) icon.textContent = dark ? "\u2600" : "\u263D";
        var label = button.querySelector(".visually-hidden");
        if (label) label.textContent = dark ? "Light theme" : "Dark theme";
      }
    );
  }

  function initTheme() {
    var theme = effectiveTheme();
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    syncThemeUi();
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-theme-toggle]"),
      function (button) {
        button.addEventListener("click", function () {
          var cur = document.documentElement.getAttribute("data-theme");
          var isDark = cur === "dark" ||
            (!cur && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
          applyTheme(isDark ? "light" : "dark");
        });
      }
    );
  }

  // ── Preferences (#771 / #772) ─────────────────────────────────────────────

  /** Column keys that are always shown, regardless of preference. */
  function isColumnVisible(key) {
    if (ALWAYS_VISIBLE.indexOf(key) >= 0) return true;
    var cols = prefs.get().columns || {};
    return cols[key] !== false;
  }

  /** Apply persisted display preferences to the view-state store. */
  function applyPreferences() {
    var p = prefs.get();
    store.update({ pageSize: p.pageSize });
    store.update({ autoRefresh: !!p.autoRefresh });
    if (p.theme === "light" || p.theme === "dark") {
      document.documentElement.setAttribute("data-theme", p.theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    syncThemeUi();
    syncPrefsUi();
    applyColumnVisibility();
  }

  /** Reflect the current preferences into the settings dialog controls. */
  function syncPrefsUi() {
    var p = prefs.get();
    var size = $("prefs-page-size");
    if (size) size.value = String(p.pageSize);
    var auto = $("prefs-auto-refresh");
    if (auto) auto.checked = !!p.autoRefresh;
    var theme = $("prefs-theme");
    if (theme) theme.value = p.theme || "system";
    var tz = $("prefs-timezone");
    if (tz) tz.value = p.timezone || "local";
    syncColumnMenuUi();
  }

  /** Reflect column visibility into the column menu checkboxes. */
  function syncColumnMenuUi() {
    Array.prototype.forEach.call(
      document.querySelectorAll("#columns-menu input[data-column]"),
      function (box) {
        var key = box.getAttribute("data-column");
        box.checked = isColumnVisible(key);
        box.disabled = ALWAYS_VISIBLE.indexOf(key) >= 0;
      }
    );
  }

  /** Toggle table column visibility via data-column attributes. */
  function applyColumnVisibility() {
    COLUMNS.forEach(function (key) {
      var visible = isColumnVisible(key);
      Array.prototype.forEach.call(
        document.querySelectorAll('[data-column="' + key + '"]'),
        function (node) {
          if (node.tagName === "TH" || node.tagName === "TD") {
            node.hidden = !visible;
          } else {
            node.hidden = !visible;
          }
        }
      );
    });
    syncColumnMenuUi();
  }

  /** Build the column menu checkboxes once. */
  function renderColumnMenu() {
    var menu = $("columns-menu");
    if (!menu) return;
    var list = menu.querySelector(".columns-list");
    if (!list) return;
    clear(list);
    COLUMNS.forEach(function (key) {
      var li = el("li", "columns-item");
      var label = el("label", "columns-label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("data-column", key);
      box.checked = isColumnVisible(key);
      box.disabled = ALWAYS_VISIBLE.indexOf(key) >= 0;
      box.addEventListener("change", function () {
        if (ALWAYS_VISIBLE.indexOf(key) >= 0) { box.checked = true; return; }
        var cols = Object.assign({}, prefs.get().columns || {});
        cols[key] = box.checked;
        prefs.update({ columns: cols });
        applyColumnVisibility();
      });
      label.appendChild(box);
      label.appendChild(el("span", null, columnLabel(key)));
      li.appendChild(label);
      list.appendChild(li);
    });
  }

  function columnLabel(key) {
    switch (key) {
      case "status":   return "Status";
      case "amount":   return "Amount";
      case "asset":    return "Asset";
      case "webhook":  return "Webhook";
      case "memo":     return "Memo";
      case "created":  return "Created";
      case "id":       return "Payment ID";
      default:         return key;
    }
  }

  function openSettings() {
    syncPrefsUi();
    openModal($("settings"));
  }

  function closeSettings() {
    closeModal($("settings"));
  }

  function resetPreferences() {
    prefs.reset();
    applyPreferences();
    onFilterChange();
    announce("Preferences reset to defaults");
  }

  /** Wire the settings dialog and column menu. Called once from init(). */
  function initPreferences() {
    renderColumnMenu();

    var settingsBtn = $("settings-open");
    if (settingsBtn) settingsBtn.addEventListener("click", openSettings);

    var settingsClose = $("settings-close");
    if (settingsClose) settingsClose.addEventListener("click", closeSettings);

    var settingsDone = $("settings-done");
    if (settingsDone) settingsDone.addEventListener("click", closeSettings);

    var settingsReset = $("settings-reset");
    if (settingsReset) settingsReset.addEventListener("click", resetPreferences);

    var settings = $("settings");
    if (settings) {
      settings.addEventListener("click", function (ev) {
        if (ev.target !== settings) return;
        var rect = settings.getBoundingClientRect();
        var outside =
          ev.clientX < rect.left || ev.clientX > rect.right ||
          ev.clientY < rect.top  || ev.clientY > rect.bottom;
        if (outside) closeSettings();
      });
    }

    var size = $("prefs-page-size");
    if (size) {
      size.addEventListener("change", function () {
        prefs.update({ pageSize: Number(size.value) || 25 });
        store.update({ pageSize: prefs.get().pageSize });
        onFilterChange();
      });
    }

    var auto = $("prefs-auto-refresh");
    if (auto) {
      auto.addEventListener("change", function () {
        prefs.update({ autoRefresh: auto.checked });
        store.update({ autoRefresh: auto.checked });
        onFilterChange();
      });
    }

    var theme = $("prefs-theme");
    if (theme) {
      theme.addEventListener("change", function () {
        applyTheme(theme.value);
      });
    }

    var tz = $("prefs-timezone");
    if (tz) {
      tz.addEventListener("change", function () {
        prefs.update({ timezone: tz.value });
        renderRows();
      });
    }

    var columnsBtn = $("columns-open");
    if (columnsBtn) {
      columnsBtn.addEventListener("click", function () {
        var menu = $("columns-menu");
        if (!menu) return;
        show(menu, menu.hidden);
        syncColumnMenuUi();
      });
    }

    var columnsClose = $("columns-close");
    if (columnsClose) {
      columnsClose.addEventListener("click", function () {
        show($("columns-menu"), false);
      });
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────

  /**
   * Call the gateway. The key is attached as an `Authorization` header and
   * nowhere else — never a query parameter, never the fragment.
   *
   * POST body is passed via `opts.body` (a JSON string); `opts.headers` carries
   * any extra headers (e.g. Content-Type, Idempotency-Key). The pinned line
   * in dashboard_asset_tests.rs matches the fetch call below verbatim.
   */
  function api(path, options) {
    var opts = options || {};
    var headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    var key = store.get().key;
    if (key) headers.Authorization = "Bearer " + key;

    return fetch(API_BASE + path, { method: opts.method || "GET", headers: headers, body: opts.body || undefined }).then(
      function (res) {
        if (res.status === 401) {
          signOut(t("error.rejected"));
          throw new Error("unauthorized");
        }
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (body) {
            if (!res.ok) {
              throw new Error(body.error || t("error.requestFailed", { status: res.status }));
            }
            return body;
          });
      }
    );
  }

  // ── Session ───────────────────────────────────────────────────────────────

  function showGate(message) {
    store.update({ key: null, selectedPaymentId: null, activeRow: -1 });
    closeDetail();
    show($("app"), false);
    show($("gate"), true);
    setError($("gate-error"), message || null);
  }

  function signOut(message) {
    session.clear();
    showGate(message);
  }

  function signIn(key, persist) {
    store.update({ key: key });
    applyHash();
    return api("/payments?limit=1").then(function () {
      if (persist !== null) session.write(key, persist);
      show($("gate"), false);
      show($("app"), true);
      setError($("gate-error"), null);
      updateSessionExpiry();
      loadVersion();
      pollHealth();
      loadSummary();
      reload();
    });
  }

  // ── Payments list ──────────────────────────────────────────────────────────

  var reloadPending = false;

  function reload() {
    store.resetPaging();
    store.update({ loadedPayments: [] });
    clear($("rows"));
    clearListState();
    loadPayments();
  }

  function loadPayments() {
    var state = store.get();
    if (state.loading) {
      reloadPending = true;
      return;
    }
    store.update({ loading: true });
    setError($("list-error"), null);
    announce("Loading payments");

    var isFirstPage = !state.cursor;
    if (isFirstPage) showSkeletonRows(5);

    api(buildListQuery(state))
      .then(function (body) {
        clearSkeletonRows();
        var payments = body.payments || [];
        var rows = store.get().loadedPayments.concat(payments);
        store.update({ loadedPayments: rows });
        renderRows();

        var more = payments.length === store.get().pageSize && !!body.next_cursor;
        store.update({ cursor: more ? body.next_cursor : null });
        show($("load-more"), more);

        var visible = store.visiblePayments();
        if (store.get().loadedPayments.length === 0) {
          setListState(buildEmptyState("📭", "No payments found",
            emptyMessageForFilter(store.get().status), null));
        } else if (visible.length === 0) {
          setListState(buildEmptyState("🔍", "No matches",
            'Nothing matches "' + store.get().search + '". Clear the search box to see every loaded payment.', null));
        } else {
          clearListState();
        }
      })
      .catch(function (err) {
        clearSkeletonRows();
        if (err.message !== "unauthorized") {
          setListState(buildErrorState(err.message, function () {
            clearListState();
            reload();
          }));
        }
      })
      .then(function () {
        store.update({ loading: false });
        if (reloadPending) {
          reloadPending = false;
          store.resetPaging();
          loadPayments();
        }
      });
  }

  function loadSummary() {
    api("/payments/summary")
      .then(function (body) {
        var summary = $("summary");
        clear(summary);
        (body.summary || []).forEach(function (row) {
          var card = el("div", "summary-card");
          card.appendChild(el("span", "muted small", row[0]));
          card.appendChild(el("strong", null, row[1]));
          summary.appendChild(card);
        });
      })
      .catch(function (err) {
        clear($("summary"));
        announce("Error loading summary: " + err.message);
      });
  }

  function renderRows() {
    var tbody = $("rows");
    var visible = sortedVisiblePayments();
    var active = store.get().activeRow;
    clear(tbody);
    visible.forEach(function (p, index) {
      tbody.appendChild(rowFor(p, index === active));
    });
    show($("empty"), visible.length === 0);
    announceRow(visible, active);
  }

  function announceRow(visible, active) {
    var node = $("rows-status");
    if (!node) return;
    if (active < 0 || active >= visible.length) {
      node.textContent = visible.length
        ? visible.length + (visible.length === 1 ? " payment" : " payments")
        : "";
      return;
    }
    var p = visible[active];
    node.textContent = "Row " + (active + 1) + " of " + visible.length + ": " +
      p.status + ", " + formatAmount(p.amount, p.asset) + ", memo " + p.memo;
  }

  // ── Skeleton helpers (#719) ───────────────────────────────────────────────

  function showSkeletonRows(count) {
    var tbody = $("rows");
    for (var i = 0; i < count; i++) {
      var tr = document.createElement("tr");
      tr.className = "skeleton-row";
      tr.setAttribute("aria-hidden", "true");
      var cols = [
        { label: "Select",     cls: "sk-select",     key: null },
        { label: "Status",     cls: "sk-status",     key: "status" },
        { label: "Amount",     cls: "sk-amount",     key: "amount" },
        { label: "Asset",      cls: "sk-asset",      key: "asset" },
        { label: "Webhook",    cls: "sk-webhook",    key: "webhook" },
        { label: "Memo",       cls: "sk-memo",       key: "memo" },
        { label: "Created",    cls: "sk-date",       key: "created" },
        { label: "Payment ID", cls: "sk-id",         key: "id" },
      ];
      cols.forEach(function (col) {
        var td = document.createElement("td");
        td.setAttribute("data-label", col.label);
        if (col.key) td.setAttribute("data-column", col.key);
        if (col.key && !isColumnVisible(col.key)) td.hidden = true;
        td.appendChild(el("span", "skeleton-cell " + col.cls));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function clearSkeletonRows() {
    var tbody = $("rows");
    if (!tbody) return;
    var skeletons = tbody.querySelectorAll(".skeleton-row");
    for (var i = 0; i < skeletons.length; i++) tbody.removeChild(skeletons[i]);
  }

  function showDetailSkeleton() {
    var fields = $("detail-fields");
    clear(fields);
    var rows = [
      { dtWidth: "4rem", ddCls: "skeleton-field skeleton-field-short" },
      { dtWidth: "4rem", ddCls: "skeleton-field skeleton-field-short" },
      { dtWidth: "5rem", ddCls: "skeleton-field skeleton-field-long" },
      { dtWidth: "6rem", ddCls: "skeleton-field skeleton-field-full" },
      { dtWidth: "5rem", ddCls: "skeleton-field skeleton-field-full" },
      { dtWidth: "6rem", ddCls: "skeleton-field skeleton-field-long" },
      { dtWidth: "4rem", ddCls: "skeleton-field skeleton-field-short" },
    ];
    rows.forEach(function (row) {
      var dt = document.createElement("dt");
      var dtBlock = el("span", "skeleton-field skeleton-field-short");
      dtBlock.style.width = row.dtWidth;
      dtBlock.setAttribute("aria-hidden", "true");
      dt.appendChild(dtBlock);
      fields.appendChild(dt);
      var dd = document.createElement("dd");
      var ddBlock = el("span", row.ddCls);
      ddBlock.setAttribute("aria-hidden", "true");
      dd.appendChild(ddBlock);
      fields.appendChild(dd);
    });
  }

  // ── Empty / error state helpers (#720) ────────────────────────────────────

  function buildEmptyState(icon, title, message, onRetry) {
    var wrap = el("div", "empty-state");
    wrap.setAttribute("role", "status");
    var iconEl = el("span", "empty-state-icon", icon);
    iconEl.setAttribute("aria-hidden", "true");
    wrap.appendChild(iconEl);
    wrap.appendChild(el("span", "empty-state-title", title));
    wrap.appendChild(el("p", "empty-state-body muted", message));
    if (onRetry) {
      var btn = el("button", "ghost", "Try again");
      btn.type = "button";
      btn.addEventListener("click", onRetry);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function buildErrorState(message, onRetry) {
    var wrap = el("div", "error-state");
    wrap.appendChild(el("p", "error-state-message", message));
    var btn = el("button", "ghost", "Retry");
    btn.type = "button";
    btn.addEventListener("click", onRetry);
    wrap.appendChild(btn);
    return wrap;
  }

  function emptyMessageForFilter(status) {
    switch (status) {
      case "pending":   return "No pending payments. New payments will appear here once created.";
      case "completed": return "No completed payments match your current filters.";
      case "underpaid": return "No underpaid payments. Underpaid intents appear here until topped up.";
      case "expired":   return "No expired payments in this date range.";
      default:          return "No payments have been created yet. Create a payment intent to get started.";
    }
  }

  function clearListState() {
    var prev = $("list-state");
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    show($("empty"), false);
  }

  function setListState(node) {
    clearListState();
    node.id = "list-state";
    var rowsEl = $("rows");
    if (rowsEl && rowsEl.parentNode) rowsEl.parentNode.insertBefore(node, rowsEl.nextSibling);
  }

  // ── Row rendering ──────────────────────────────────────────────────────────

  var selectedPayments = {};

  function setSelected(p, on) {
    if (on) selectedPayments[p.id] = p; else delete selectedPayments[p.id];
  }

  function syncSelectionUi() {
    var ids = Object.keys(selectedPayments);
    var count = $("selection-count");
    var exportSel = $("export-selected");
    if (count) {
      count.textContent = ids.length ? ids.length + " selected" : "";
      show(count, ids.length > 0);
    }
    if (exportSel) show(exportSel, ids.length > 0);
  }

  function labelledCell(label, className, text) {
    var td = el("td", className, text);
    td.setAttribute("data-label", label);
    return td;
  }

  function rowFor(p, isActive) {
    var tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.paymentId = p.id;
    if (isActive) {
      tr.className = "row-active";
      tr.setAttribute("aria-current", "true");
    }
    if (selectedPayments[p.id]) selectedPayments[p.id] = p;

    var selectCell = document.createElement("td");
    selectCell.setAttribute("data-label", "Select");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.className = "row-select";
    box.setAttribute("data-id", p.id);
    box.setAttribute("aria-label", "Select payment " + p.id);
    box.checked = !!selectedPayments[p.id];
    box.addEventListener("click", function (ev) { ev.stopPropagation(); });
    box.addEventListener("keydown", function (ev) { ev.stopPropagation(); });
    box.addEventListener("change", function () {
      setSelected(p, box.checked);
      syncSelectionUi();
    });
    selectCell.appendChild(box);
    tr.appendChild(selectCell);

    var statusCell = document.createElement("td");
    statusCell.setAttribute("data-label", "Status");
    statusCell.setAttribute("data-column", "status");
    statusCell.appendChild(el("span", pillClass(p.status), p.status));
    tr.appendChild(statusCell);

    var amountCell = labelledCell("Amount", null, formatAmount(p.amount, p.asset));
    amountCell.setAttribute("data-column", "amount");
    if (!isColumnVisible("amount")) amountCell.hidden = true;
    tr.appendChild(amountCell);

    /* Asset column (#773). */
    var assetCell = labelledCell("Asset", "mono", p.asset || "XLM");
    assetCell.setAttribute("data-column", "asset");
    if (!isColumnVisible("asset")) assetCell.hidden = true;
    tr.appendChild(assetCell);

    /* Webhook status column (#773). */
    var webhookCell = document.createElement("td");
    webhookCell.setAttribute("data-label", "Webhook");
    webhookCell.setAttribute("data-column", "webhook");
    webhookCell.appendChild(webhookBadge(p));
    if (!isColumnVisible("webhook")) webhookCell.hidden = true;
    tr.appendChild(webhookCell);

    var memoCell = labelledCell("Memo", "mono", p.memo);
    memoCell.setAttribute("data-column", "memo");
    if (!isColumnVisible("memo")) memoCell.hidden = true;
    tr.appendChild(memoCell);

    var createdCell = labelledCell("Created", null, fmtTime(p.created_at));
    createdCell.setAttribute("data-column", "created");
    if (!isColumnVisible("created")) createdCell.hidden = true;
    tr.appendChild(createdCell);

    var idCell = labelledCell("Payment ID", "mono", shortId(p.id));
    idCell.setAttribute("data-column", "id");
    tr.appendChild(idCell);

    tr.addEventListener("click", function () { openDetail(p.id, tr); });
    tr.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(p.id, tr); }
    });
    return tr;
  }

  /**
   * Webhook status badge for the list (#773).
   *
   * The list response may carry `webhook_status` ("delivered" | "failing" |
   * "none"); when it is absent we render a neutral "—" rather than guessing.
   */
  function webhookBadge(p) {
    var status = p && p.webhook_status;
    if (status === "delivered") return el("span", "pill pill-ok", "delivered");
    if (status === "failing") return el("span", "pill pill-err", "failing");
    if (status === "none") return el("span", "pill", "none");
    return el("span", "muted", "\u2014");
  }

  // ── Detail panel (#715) ───────────────────────────────────────────────────

  /**
   * Open the detail drawer as a real modal dialog.
   * Stores the trigger row so focus can be returned on close.
   */
  function openDetail(id, trigger) {
    store.update({ selectedPaymentId: id });
    state.detailTrigger = trigger || null;

    var detail = $("detail");
    var fields = $("detail-fields");
    clear(fields);
    clear($("deliveries"));
    setError($("deliveries-error"), null);
    show($("deliveries-empty"), false);

    showDetailSkeleton();
    openModal(detail);
    focusDetail();

    api("/payments/" + encodeURIComponent(id))
      .then(function (p) {
        clear(fields);
        [
          [t("field.status"), p.status, true],
          [t("field.amount"), formatAmount(p.amount, p.asset)],
          [t("field.received"), p.paid_amount ? formatAmount(p.paid_amount, p.asset) : "—"],
          [t("field.memo"), p.memo],
          [t("field.destination"), p.destination_address],
          [t("field.transaction"), p.tx_hash || "—"],
          [t("field.network"), "Stellar"],
          [t("field.assetIssuer"), p.asset_issuer || "native"],
          [t("field.paymentId"), p.id],
          [t("field.merchant"), p.merchant_id],
          [t("field.created"), fmtTime(p.created_at)],
          [t("field.updated"), fmtTime(p.updated_at)],
          [t("field.expires"), fmtTime(p.expires_at) +
            (p.status === "pending" ? " (" + countdown(p.expires_at) + " left)" : "")],
        ].forEach(function (pair) {
          fields.appendChild(el("dt", null, pair[0]));
          if (pair[2]) {
            var dd = document.createElement("dd");
            dd.appendChild(el("span", pillClass(p.status), p.status));
            fields.appendChild(dd);
          } else if (pair[0] === t("field.transaction") && p.tx_hash) {
            var tx = document.createElement("dd");
            var link = el("a", "mono", shortId(p.tx_hash));
            link.href = explorerTx(p.tx_hash);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            tx.appendChild(link);
            fields.appendChild(tx);
          } else {
            fields.appendChild(el("dd", "mono", pair[1]));
          }
        });
      })
      .catch(function (err) {
        clear(fields);
        if (err.message !== "unauthorized") {
          var errNode = buildErrorState(err.message, function () { openDetail(id); });
          var wrapper = document.createElement("dd");
          wrapper.appendChild(errNode);
          fields.appendChild(el("dt", null, "Error"));
          fields.appendChild(wrapper);
        }
      });

    loadDeliveries(id);
  }

  /** Move focus to the first focusable element inside the detail panel. */
  function focusDetail() {
    var detail = $("detail");
    if (!detail) return;
    var focusable = detail.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length) focusable[0].focus();
  }

  /**
   * Tab trap for the detail drawer (#714).
   * Wraps Tab in both directions so focus stays inside while the modal is open.
   */
  function trapDetailFocus(ev) {
    if (ev.key !== "Tab") return;
    var detail = $("detail");
    if (!detail) return;
    var focusable = Array.prototype.slice.call(detail.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    if (!focusable.length) return;
   
