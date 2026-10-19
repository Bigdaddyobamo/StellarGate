#!/usr/bin/env node
/* Launch the gateway for the end-to-end suite.
 *
 * Playwright's `webServer` wants a command and a URL to poll. The server needs
 * several environment variables and a freshly built binary, and a failing build
 * should print cargo's own diagnostics rather than a bare exit code — so the
 * orchestration lives here instead of in a shell one-liner in the workflow.
 *
 * Dev-only. Nothing in this directory is compiled into the gateway binary.
 *
 * Two modes:
 *   node e2e/scripts/serve.mjs            spawn the built gateway binary
 *   node e2e/scripts/serve.mjs --static   serve static/ with the gateway's
 *                                         path layout, no Rust toolchain
 *
 * The static mode exists so the dashboard smoke test can run in CI without
 * `cargo build`. It maps the same URLs the gateway serves:
 *   /dashboard        -> static/dashboard.html
 *   /dashboard/app.js -> static/dashboard.js
 *   /dashboard/x.css  -> static/x.css
 * and stubs /v1/* from e2e/fixtures/ so the page can sign in and render.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

if (process.argv.includes("--static")) {
  serveStatic();
} else {
  serveGateway();
}

function serveGateway() {
  const binary = join(repoRoot, "target", "debug", "stellargate");

  if (!existsSync(binary)) {
    console.error(
      `The gateway binary is missing at ${binary}.\n` +
        `Build it first:  cargo build --locked`,
    );
    process.exit(1);
  }

  const child = spawn(binary, [], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  /* Forward the signals Playwright sends on teardown, so the child gets a chance
     to drain rather than being killed mid-write and leaving a locked SQLite
     file behind for the next run. */
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* Map a request path to a file under static/, mirroring the gateway's layout:
 * `/dashboard` and `/dashboard/` serve dashboard.html, and `/dashboard/<name>`
 * serves static/<name> (so `/dashboard/app.js` -> static/dashboard.js is
 * handled by the caller's alias table). */
function resolveStatic(pathname) {
  const staticDir = join(repoRoot, "static");
  let rel = pathname.replace(/^\/+/, "");

  if (rel === "" || rel === "dashboard" || rel === "dashboard/") {
    return join(staticDir, "dashboard.html");
  }
  if (rel.startsWith("dashboard/")) {
    rel = rel.slice("dashboard/".length);
    // The page imports `./app.js`; the gateway serves it from dashboard.js.
    if (rel === "app.js") rel = "dashboard.js";
  }

  const target = normalize(join(staticDir, rel));
  if (!target.startsWith(staticDir)) return null;
  return target;
}

function serveStatic() {
  const port = Number(process.env.PORT ?? 4173);
  const fixturesDir = join(repoRoot, "e2e", "fixtures");

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/v1/")) {
      // Stub the API from e2e/fixtures/<name>.json when present, else 200 {}.
      const name = pathname.slice("/v1/".length).replace(/\//g, "_") || "index";
      const fixture = join(fixturesDir, `${name}.json`);
      const body = existsSync(fixture) ? readFileSync(fixture) : "{}";
      res.writeHead(200, { "content-type": MIME[".json"] });
      res.end(body);
      return;
    }

    const file = resolveStatic(pathname);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`not found: ${pathname}\n`);
      return;
    }

    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(readFileSync(file));
  });

  server.listen(port, () => {
    console.log(`static server listening on http://localhost:${port}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
