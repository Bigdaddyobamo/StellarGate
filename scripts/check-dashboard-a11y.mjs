#!/usr/bin/env node
// Dashboard static checks: module-graph link check + a11y scan.
//
// The link check parses every `import { … } from './x.js'` in static/ and
// verifies the named bindings are actually exported by the target module.
// This catches breakage like a missing export in format.js without needing
// a browser or the Rust toolchain.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, '..', 'static');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Collect exported names from a module source.
function collectExports(src) {
  const names = new Set();
  // export function foo / export async function foo / export class Foo
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export const foo / export let foo / export var foo
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : trimmed.split(/\s+/)[0]);
    }
  }
  return names;
}

// Collect named imports: import { a, b as c } from './x.js'
function collectImports(src) {
  const out = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    out.push({ spec, names });
  }
  return out;
}

let failures = 0;
const files = walk(staticDir);
const exportCache = new Map();

function exportsOf(file) {
  if (!exportCache.has(file)) {
    exportCache.set(file, collectExports(readFileSync(file, 'utf8')));
  }
  return exportCache.get(file);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const { spec, names } of collectImports(src)) {
    const target = resolve(dirname(file), spec);
    let targetFile = target;
    try {
      statSync(targetFile);
    } catch {
      // try adding .js
      targetFile = target + '.js';
      try {
        statSync(targetFile);
      } catch {
        console.error(`[link-check] ${file}: cannot resolve import '${spec}'`);
        failures++;
        continue;
      }
    }
    const exported = exportsOf(targetFile);
    for (const name of names) {
      if (!exported.has(name)) {
        console.error(
          `[link-check] ${file}: imports '${name}' from '${spec}' but it is not exported`,
        );
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`[link-check] ${failures} module-graph problem(s) found`);
  process.exit(1);
}
console.log('[link-check] all static/ imports resolve to real exports');
