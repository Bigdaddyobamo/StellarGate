/* End-to-end smoke test for the operator dashboard (issue #724).
 *
 * Sign in, filter, open a payment, redeliver a webhook — driven through a real
 * browser against a real server with a seeded database, because each of those
 * steps crosses a boundary a unit test cannot reach: a module the router
 * forgets to serve, a CSP that blocks an import, a filter the API rejects, a
 * confirm dialog that swallows a click.
 */

import { test, expect } from "./fixtures.js";

test.describe("dashboard smoke", () => {
  test("every module loads and the dashboard signs in", async ({ page }) => {
    /* A module that 404s does not throw a visible error — `type="module"`
       simply fails to evaluate and the page sits on the sign-in form forever,
       looking like a credentials problem. Assert on the requests themselves so
       the failure names the missing file. */
    const moduleFailures = [];
    page.on("response", (res) => {
      if (res.url().includes("/dashboard/") && !res.ok()) {
        moduleFailures.push(`${res.status()} ${res.url()}`);
      }
    });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("/dashboard");

    for (const [path, contentType] of [
      ["/dashboard/app.css", "text/css"],
      ["/dashboard/app.js", "javascript"],
      ["/dashboard/format.js", "javascript"],
      ["/dashboard/session.js", "javascript"],
      ["/dashboard/state.js", "javascript"],
      ["/dashboard/keys.js", "javascript"],
    ]) {
      const res = await page.request.get(path);
      expect(res.status(), `${path} must be served`).toBe(200);
      expect(res.headers()["content-type"], `${path} content type`).toContain(
        contentType,
      );
    }

    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
    expect(moduleFailures, "no dashboard asset may fail to load").toEqual([]);
    expect(pageErrors, "the entry module must evaluate cleanly").toEqual([]);
  });

  /* Issue #866: a fast, Rust-independent smoke test. The dashboard is served
     from `static/` with the gateway's path layout and `/v1/*` is stubbed from
     `e2e/fixtures/`, so this test catches a page that fails to load (missing
     export, undefined helper) without ever touching `cargo`. Any `pageerror`
     or `console.error` fails the test, and the message names the offending
     module or identifier. */
  test("loads, signs in, and renders payments without a Rust build", async ({
    page,
    seedData,
  }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/dashboard");

    await page.getByLabel("API key").fill(seedData.apiKey);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#gate")).toBeHidden();

    // At least one payments row must render — an empty table means the page
    // loaded but the data path is broken.
    await expect(page.locator("#rows tr").first()).toBeVisible();

    expect(pageErrors, "no pageerror may fire while loading the dashboard").toEqual(
      [],
    );
    expect(
      consoleErrors,
      "no console.error may fire while loading the dashboard",
    ).toEqual([]);
  });

  /** The row whose memo cell holds `memo`. Scoped to the memo cell so a label
   *  elsewhere on the page cannot satisfy the locator. */
  function rowWithMemo(page, memo) {
    return page.locator("#rows tr").filter({
      has: page.locator("td", { hasText: new RegExp(`^${memo}$`) }),
    });
  }

  test("signs in and lists the seeded payments", async ({ page, seedData }) => {
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(seedData.apiKey);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#gate")).toBeHidden();

    const rows = page.locator("#rows tr");
    await expect(rows).toHaveCount(4);

    // Every seeded memo is present, so a filter silently dropping rows is
    // visible here rather than as a mysteriously short list.
    for (const memo of ["alpha", "bravo", "charlie", "delta"]) {
      await expect(rowWithMemo(page, `e2e-order-${memo}`)).toHaveCount(1);
    }

    // The status pills reflect the seeded statuses, which is what the summary
    // cards and the filters are derived from.
    await expect(rowWithMemo(page, "e2e-order-alpha")).toContainText("completed");
    await expect(rowWithMemo(page, "e2e-order-delta")).toContainText("pending");

    // The API is healthy, so the health pill resolves rather than sitting on
    // "checking…" forever.
    await expect(page.locator("#health")).toHaveText("healthy");
  });

  test("the summary is scoped to the signed-in merchant", async ({
    page,
    seedData,
  }) => {
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(seedData.apiKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr").first()).toBeVisible();

    /* The summary aggregates one merchant's payments, so it must be behind the
       same credential check as the list. An unauthenticated call used to reach
       the handler with no merchant identity and answer 500. */
    const unauth = await page.request.get("/v1/payments/summary");
    expect(unauth.status()).toBe(401);

    // And with a credential it returns this merchant's own totals.
    const authed = await page.request.get("/v1/payments/summary", {
      headers: { Authorization: `Bearer ${seedData.apiKey}` },
    });
    expect(authed.status()).toBe(200);
    expect((await authed.json()).summary).toBeTruthy();
  });

  test("rejects a bad key without leaving a broken page", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill("sg_not_a_real_key_at_all");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Either the gate reports the rejection or it bounces straight back; both
    // are acceptable, a blank page is not.
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#app")).toBeHidden();
  });

  test("filters the list by status", async ({ page, seedData }) => {
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(seedData.apiKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr")).toHaveCount(4);

    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await expect(page.locator("#rows tr")).toHaveCount(1);
    await expect(rowWithMemo(page, "e2e-order-alpha")).toHaveCount(1);

    await page.getByRole("button", { name: "Pending", exact: true }).click();
    await expect(page.locator("#rows tr")).toHaveCount(1);
    await expect(rowWithMemo(page, "e2e-order-delta")).toHaveCount(1);

    // The filter lives in the URL hash, so the view is shareable — and the
    // hash is a place a credential must never appear.
    await expect(page).toHaveURL(/#status=pending/);

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.locator("#rows tr")).toHaveCount(4);
  });

  test("searches the loaded rows", async ({ page, seedData }) => {
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(seedData.apiKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr")).toHaveCount(4);

    const search = page.getByLabel("Search payments");
    await search.fill("charlie");
    await expect(page.locator("#rows tr")).toHaveCount(1);
    await expect(rowWithMemo(page, "e2e-order-charlie")).toHaveCount(1);

    // The clear button only appears when there is something to clear, and
    // clearing restores the full list.
    const clear = page.getByRole("button", { name: "Clear search" });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator("#rows tr")).toHaveCount(4);
  });

  test("opens a payment and shows its detail panel", async ({ page, seedData }) => {
    await page.goto("/dashboard");
    await page.getByLabel("API key").fill(seedData.apiKey);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#rows tr")).toHaveCount(4);

    await rowWithMemo(page, "e2e-order-alpha").click();

    const detail = page.locator("#detail");
    await expect(detail).toBeVisible();
    await expect(rowWithMemo(page, "e2e-order-alpha")).toHaveCount(1);

    // Detail fields that only exist because of specific features.
    await expect(detail).toContainText("Network");
    await expect(detail).toContainText("Stellar");
    await expect(detail).toContainText("Asset issuer");
    await expect(detail).toContainText("42.5 XLM");

    // The transaction hash links out to an explorer, in a new tab, with
    // `rel` set so the opened page cannot reach back through window.opener.
    const link = detail.getByRole("link");
    await expect(link).toHaveAttribute("href", /stellar\.expert/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });
});

/* Visual regression coverage (issue #826).
 *
 * CSS refactors (#685, #686) can quietly change the layout, so the gate, the
 * table, the drawer and the empty states are snapshotted in light and dark at
 * desktop and mobile widths. Baselines live under `e2e/tests/__screenshots__`
 * and are committed; a diff above `maxDiffPixelRatio` fails CI.
 *
 * The API key is only ever typed into the gate input and sent as an
 * Authorization header — never placed in a URL, log line or console output.
 * The gate snapshot is taken before any key is entered, and the signed-in
 * snapshots mask the key field so a credential cannot leak into a baseline.
 */

const THEMES = ["light", "dark"];
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

// A small tolerance absorbs sub-pixel font rasterisation differences between
// Chrome, Firefox and Safari without hiding a real layout change.
const SNAPSHOT_OPTIONS = { maxDiffPixelRatio: 0.02, animations: "disabled" };

async function applyTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

async function signIn(page, seedData) {
  await page.getByLabel("API key").fill(seedData.apiKey);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#rows tr").first()).toBeVisible();
}

test.describe("dashboard visual regression", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`gate, table, drawer and empty states — ${viewport.name} ${theme}`, async ({
        page,
        seedData,
      }) => {
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await page.goto("/dashboard");
        await applyTheme(page, theme);

        // Gate: the sign-in form, before any credential is entered.
        await expect(page.locator("#gate")).toBeVisible();
        await expect(page.locator("#gate")).toHaveScreenshot(
          `gate-${viewport.name}-${theme}.png`,
          SNAPSHOT_OPTIONS,
        );

        await signIn(page, seedData);

        // Table: the populated list. Mask the key field so a credential can
        // never end up baked into a committed baseline.
        await expect(page.locator("#app")).toHaveScreenshot(
          `table-${viewport.name}-${theme}.png`,
          { ...SNAPSHOT_OPTIONS, mask: [page.getByLabel("API key")] },
        );

        // Drawer: the detail panel for a single payment.
        await rowWithMemo(page, "e2e-order-alpha").click();
        await expect(page.locator("#detail")).toBeVisible();
        await expect(page.locator("#detail")).toHaveScreenshot(
          `drawer-${viewport.name}-${theme}.png`,
          SNAPSHOT_OPTIONS,
        );

        // Empty state: a search that matches nothing.
        await page.getByLabel("Search payments").fill("no-such-payment-xyz");
        await expect(page.locator("#rows tr")).toHaveCount(0);
        await expect(page.locator("#app")).toHaveScreenshot(
          `empty-${viewport.name}-${theme}.png`,
          { ...SNAPSHOT_OPTIONS, mask: [page.getByLabel("API key")] },
        );
      });
    }
  }
});
