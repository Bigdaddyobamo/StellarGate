/* #766: isolated admin controller. Credentials exist only in this closure. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let secret = null;
  let revision = 0;
  let busy = false;
  let merchant = null;
  function hideKey() { $("new-key").textContent = ""; $("new-key").hidden = true; $("hide-key").hidden = true; }
  function signOut() {
    secret = null; merchant = null; revision++; busy = false;
    $("admin-secret").value = ""; $("merchant-id").value = ""; $("key-label").value = "";
    $("admin-output").replaceChildren(); hideKey();
    $("issue-form").hidden = true; $("admin-app").hidden = true; $("admin-gate").hidden = false;
    $("admin-status").textContent = "No merchant selected.";
    $("admin-error").hidden = true;
  }
  async function request(method, id, keyId, body) {
    const generation = revision;
    const response = await fetch("/v1/merchants/" + encodeURIComponent(id) + "/keys" +
      (keyId ? "/" + encodeURIComponent(keyId) : ""), {
      method, credentials: "omit", cache: "no-store", redirect: "error",
      headers: { "X-Admin-Secret": secret, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (generation !== revision) throw new Error("Session ended.");
    if (response.status === 401 || response.status === 403) {
      signOut(); throw new Error("Admin secret rejected. Please sign in again.");
    }
    if (!response.ok) throw new Error("Request failed (" + response.status + "). Check the merchant ID and key status.");
    const result = await response.json();
    if (generation !== revision) throw new Error("Session ended.");
    return result;
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = true; });
    try { await action(); }
    catch (_) {
      const target = secret ? $("admin-status") : $("admin-error");
      target.textContent = "Unable to complete request. Check your credentials, merchant ID and connection.";
      target.hidden = false;
    } finally {
      busy = false;
      document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = false; });
    }
  }
  async function list(id) {
    const data = await request("GET", id);
    merchant = id;
    $("admin-output").replaceChildren();
    for (const key of data.keys || []) {
      const item = document.createElement("li");
      const description = document.createElement("span");
      description.textContent = (key.label || "Unlabelled") + " · " + key.prefix + " · " + (key.active ? "Active" : "Revoked");
      item.appendChild(description);
      if (key.active) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = "Revoke";
        button.addEventListener("click", () => {
          if (!window.confirm("Revoke this key immediately? Applications using it will lose access.")) return;
          run(async () => { hideKey(); await request("DELETE", id, key.key_id); await list(id); });
        });
        item.appendChild(button);
      }
      $("admin-output").appendChild(item);
    }
    $("admin-status").textContent = (data.keys || []).length + " keys for " + id;
    $("issue-form").hidden = false;
    $("admin-app").hidden = false; $("admin-gate").hidden = true;
  }
  $("admin-form").addEventListener("submit", event => {
    event.preventDefault();
    secret = $("admin-secret").value.trim(); $("admin-secret").value = "";
    if (!secret) return;
    revision++;
    $("admin-gate").hidden = true; $("admin-app").hidden = false;
    $("admin-status").textContent = "Enter a merchant ID to verify your secret and list keys.";
    $("merchant-id").focus();
  });
  $("merchant-form").addEventListener("submit", event => {
    event.preventDefault(); hideKey(); merchant = null; $("issue-form").hidden = true;
    const id = $("merchant-id").value.trim();
    if (id) run(() => list(id));
  });
  $("issue-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!merchant) return;
    const id = merchant;
    run(async () => {
      hideKey();
      const result = await request("POST", id, null, { label: $("key-label").value.trim() || null });
      $("new-key").textContent = "Save this key now; it is shown once: " + result.api_key;
      $("new-key").hidden = false; $("hide-key").hidden = false;
      $("key-label").value = "";
      await list(id);
    });
  });
  $("hide-key").addEventListener("click", hideKey);
  $("admin-sign-out").addEventListener("click", signOut);
  window.addEventListener("pagehide", signOut);
})();
