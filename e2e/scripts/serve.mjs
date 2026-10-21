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
 * Set MOCK_API=1 to skip the gateway entirely and serve `static/` plus canned
 * JSON fixtures for the dashboard (see `mock-api.mjs`). That mode needs no
 * Postgres, Horizon or API key, so the UI can be developed offline.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binary = join(repoRoot, "target", "debug", "stellargate");

if (process.env.MOCK_API === "1") {
  const { startMockApi } = await import("./mock-api.mjs");
  const port = Number(process.env.MOCK_API_PORT ?? 8787);
  const server = await startMockApi({ root: repoRoot, port });
  console.log(`Mock API listening on ${server.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close().then(() => process.exit(0)));
  }
} else {
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
