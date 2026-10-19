#!/usr/bin/env bash
# Fails if the deploy config drifts from what the app expects.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caddyfile="$repo_root/deploy/Caddyfile"
api_mod="$repo_root/src/api/mod.rs"

fail=0

if [[ ! -f "$caddyfile" ]]; then
  echo "missing $caddyfile" >&2
  exit 1
fi

# The app sets these security headers on every response with
# `SetResponseHeaderLayer::overriding`. The proxy must not set them to a
# different value, or it silently weakens the app's policy (issue #902).
# Caddy's `header Field value` form replaces the upstream value; only the
# `?Field value` fallback form is safe.
app_owned_headers=("Referrer-Policy" "X-Content-Type-Options")

for header in "${app_owned_headers[@]}"; do
  # Match a bare `Header value` line (sets/replaces) but not `?Header value`
  # (fallback) or `-Header` (delete).
  if grep -Eq "^[[:space:]]*${header}[[:space:]]" "$caddyfile"; then
    echo "deploy/Caddyfile sets app-owned header '${header}' with a fixed value;" >&2
    echo "the app already sets it on every response. Remove it or use the" >&2
    echo "'?${header} <value>' fallback form." >&2
    fail=1
  fi
done

# Sanity: the app must still set Referrer-Policy: no-referrer.
if [[ -f "$api_mod" ]] && ! grep -q 'no-referrer' "$api_mod"; then
  echo "src/api/mod.rs no longer sets Referrer-Policy: no-referrer" >&2
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "deploy config consistent with app security headers"
