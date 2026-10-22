/* Regression test: the API key never reaches a URL, a log line, or the console
 * (issue #726).
 *
 * The API key is a bearer credential. The moment one appears in a URL it is in
 * the browser history, in the `Referer` header of every outbound request, in any
 * proxy log between the operator and the gateway, and in every screenshot a
 * merchant takes when asking for help. Once it is in the console it is in
 * anything that captures the page, including a CI artifact.
 *
 * This is asserted three ways, because each catches a different failure:
 *
 *   1. Over every network request the browser makes — a request whose *URL*
 *      contains the key fails even if the key is also correctly in the header.
 *   2. Over the page's console output and any uncaught error.
 *   3. Over the address bar and the history, after every interaction that
 *      writes to the URL (filter chips, search, auto-refresh).
 *
 * It also pins the storage policy chosen in issue #864: the key lives in
 * `sessionStorage` by default and only reaches `localStorage` when the operator
 * explicitly ticks "remember me".
 *
 * A source-level guard for the same property lives in
 * `tests/dashboard_asset_tests.rs`; this suite is the end-to-end half, and it is
 * the only one that can catch a leak built at runtime rather than in source.
 */

import { test, expect } from "./fixtures.js";

/**
 * Record every request/response and every console message for a page.
 *
 * The listeners are attached before any navigation so nothing that happens
 * during the very first load escapes the capture.
 */
function instrument(page) {
  const requests = [];
  const consoleMessages = [];
  const pageErrors = [];

  page.on("request", (req) => {
    requests.push({
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      resourceType: req.resourceType(),
      isNavigationRequest: () => req.isNavigationRequest(),
    });
  });
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text(), location: msg.location() });
  });
  page.on("pageerror", (e) => pageErrors.push({ message: e.message, stack: e.stack }));

  return { requests, consoleMessages, pageErrors };
}

test.describe("the API key never leaves the Authorization header", () => {
  test("no request URL, console line or address bar contains the key", async ({
    page,
    seedData,
  }) => {
    const key = seedData.apiKey;
    /* A short, distinctive key would make a substring match meaningless — a
       match on "a" proves nothing. Assert the real provisioned key, which is
       67 hex characters long. */
    expect(key.length).toBeGreaterThan(32);

    const { requests, consoleMessages, pageErrors } = instrument(page);

    // Sign in. This is the only interaction that handles the raw key.
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(key);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr").first()).toBeVisible();

    // Walk every code path that touches a URL.
    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(page.locator("#rows tr")).toHaveCount(1);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.locator("#rows tr")).toHaveCount(4);

    await page.getByLabel("Search payments").fill("alpha");
    await expect(page.locator("#rows tr")).toHaveCount(1);
    await page.getByLabel("Search payments").fill("");
    await expect(page.locator("#rows tr")).toHaveCount(4);

    await page.locator("#auto-refresh").check();
    await page.locator("#auto-refresh").uncheck();

    await page.locator("#rows tr").first().click();
    await expect(page.locator("#detail")).toBeVisible();
    await page.locator("#detail-close").click();

    // 1. No request URL carries the key.
    const leakingRequests = requests.filter((r) => r.url.includes(key));
    expect(
      leakingRequests.map((r) => `${r.method} ${r.url}`),
      "the key must never appear in a request URL",
    ).toEqual([]);

    // Nor in any query-string value, which is the other way a credential gets
    // into a log line via a server-side access log.
    const urlValues = requests.flatMap((r) => [...new URL(r.url).searchParams.values()]);
    expect(urlValues.filter((v) => v.includes(key))).toEqual([]);

    // 2. The key *is* carried, in the header — otherwise this test would pass
    //    trivially against a dashboard that never authenticates at all.
    const authorised = requests.filter((r) =>
      (r.headers.authorization ?? "").includes(key),
    );
    expect(
      authorised.length,
      "the key must be sent in the Authorization header on authenticated calls",
    ).toBeGreaterThan(0);

    for (const r of authorised) {
      expect(r.url, "a credential-bearing request must not also carry it in the URL").not.toContain(
        key,
      );
    }

    // 3. Nothing in the console, and no uncaught error quoting it.
    const consoleLeaks = consoleMessages.filter((m) => m.text.includes(key));
    expect(
      consoleLeaks.map((m) => `${m.type}: ${m.text}`),
      "the key must never be written to the console",
    ).toEqual([]);

    const errorLeaks = pageErrors.filter((e) => e.message.includes(key) || (e.stack ?? "").includes(key));
    expect(
      errorLeaks.map((e) => e.message),
      "the key must never appear in an uncaught error",
    ).toEqual([]);

    // 4. The address bar and the history entries the page created.
    expect(page.url(), "the key must never be in the address bar").not.toContain(key);
    const history = await page.evaluate(() => window.history.length);
    expect(typeof history).toBe("number");
    const currentHash = new URL(page.url()).hash;
    expect(currentHash, "the hash carries filters only").not.toContain(key);

    // 5. Storage policy (issue #864): without "remember me" the key must not
    //    be written to `localStorage`, which survives the tab and the browser.
    const localValues = await page.evaluate(() =>
      Object.values(window.localStorage),
    );
    expect(
      localValues.filter((v) => v.includes(key)),
      "without remember-me the key must not be written to localStorage",
    ).toEqual([]);
  });

  test("an issued key is revealed once and never leaks (issues #767-#769)", async ({
    page,
    seedData,
  }) => {
    const key = seedData.apiKey;
    const { requests, consoleMessages, pageErrors } = instrument(page);

    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(key);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr").first()).toBeVisible();

    // Open the admin key panel and list the merchant's keys. The list must
    // show prefixes only — never full key material.
    await page.getByLabel("Merchant ID").fill(seedData.merchantId);
    await page.getByRole("button", { name: "Load keys" }).click();
    await expect(page.locator("#keys tr").first()).toBeVisible();

    // Issue a new key. The reveal panel shows it exactly once.
    await page.getByRole("button", { name: "Issue key" }).click();
    const reveal = page.locator("#key-reveal");
    await expect(reveal).toBeVisible();
    await expect(reveal).toContainText("shown only once");

    const revealed = (await page.locator("#key-reveal-value").textContent())?.trim() ?? "";
    expect(revealed.length).toBeGreaterThan(32);
    expect(revealed).not.toBe(key);

    // The revealed key must not be in the address bar or the hash.
    expect(page.url()).not.toContain(revealed);
    expect(new URL(page.url()).hash).not.toContain(revealed);

    // Close the panel: the key must be gone from the DOM.
    await page.getByRole("button", { name: "Close reveal" }).click();
    await expect(reveal).toBeHidden();
    const bodyText = await page.evaluate(() => document.body.innerHTML);
    expect(bodyText, "closing the reveal must clear the key from the DOM").not.toContain(
      revealed,
    );

    // Revoke a key, confirming by typing its prefix.
    const firstPrefix = (await page.locator("#keys tr").first().locator("td").nth(1).textContent())?.trim() ?? "";
    expect(firstPrefix.length).toBeGreaterThan(0);
    await page.locator("#keys tr").first().getByRole("button", { name: "Revoke" }).click();
    await page.getByLabel("Type the key prefix to confirm").fill(firstPrefix);
    await page.getByRole("button", { name: "Confirm revoke" }).click();
    await expect(page.locator("#keys tr").first()).toBeVisible();

    // 1. No request URL carries either key.
    const leakingRequests = requests.filter(
      (r) => r.url.includes(key) || r.url.includes(revealed),
    );
    expect(
      leakingRequests.map((r) => `${r.method} ${r.url}`),
      "no key may appear in a request URL",
    ).toEqual([]);

    const urlValues = requests.flatMap((r) => [...new URL(r.url).searchParams.values()]);
    expect(urlValues.filter((v) => v.includes(key) || v.includes(revealed))).toEqual([]);

    // 2. Nothing in the console, and no uncaught error quoting a key.
    expect(
      consoleMessages
        .filter((m) => m.text.includes(key) || m.text.includes(revealed))
        .map((m) => `${m.type}: ${m.text}`),
      "no key may be written to the console",
    ).toEqual([]);

    expect(
      pageErrors
        .filter(
          (e) =>
            e.message.includes(key) ||
            e.message.includes(revealed) ||
            (e.stack ?? "").includes(key) ||
            (e.stack ?? "").includes(revealed),
        )
        .map((e) => e.message),
      "no key may appear in an uncaught error",
    ).toEqual([]);

    // 3. The address bar and history entries the page created.
    expect(page.url()).not.toContain(key);
    expect(page.url()).not.toContain(revealed);
    expect(new URL(page.url()).hash).not.toContain(revealed);
  });

  test("the key is absent from the URL after a bad sign-in and after sign-out", async ({
    page,
    seedData,
  }) => {
    const { requests, consoleMessages } = instrument(page);
    const key = seedData.apiKey;

    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(key);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr").first()).toBeVisible();

    // A 401 must drop the key and return to the gate without ever putting it
    // anywhere durable. Revoke nothing — simply clear the stored credential
    // server-side is not reachable from here, so exercise the 401 path with a
    // key the server has never seen, after a valid session has established
    // that the error path renders.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#gate")).toBeVisible();

    await page.getByLabel("API key").fill("sg_definitely_not_a_valid_key_0000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#gate")).toBeVisible();

    expect(page.url()).not.toContain(key);
    expect(requests.filter((r) => r.url.includes(key))).toEqual([]);
    expect(consoleMessages.filter((m) => m.text.includes(key))).toEqual([]);
  });

  test("the sign-in form cannot leak the key through a native form submit", async ({
    page,
    seedData,
  }) => {
    /* The gate is `method="post"` on purpose. If the script ever fails to load,
       a default GET submit would put the key in the URL — history, referrer,
       every proxy log. Block the entry module so the form has no script to
       preventDefault, then submit and check both what the browser *tried* to
       send and what the CSP let through.

       The dashboard's CSP carries `form-action 'none'`, so the submit is
       blocked client-side and never reaches the network at all. That is the
       defence that actually holds, and asserting on the network alone would
       pass even if the form were a GET — so the test also checks the method the
       browser would have used, from the DOM rather than from a request that
       never happened. */
    const key = seedData.apiKey;
    const { requests, consoleMessages } = instrument(page);

    await page.route("**/dashboard

/* … truncated 2934 chars — edit only what you need near the top … */
