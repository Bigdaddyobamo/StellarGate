#!/usr/bin/env bash
#
# Cross-checks the deploy assets against each other and against Dockerfile so
# they cannot silently drift apart as the app evolves (issues #444, #447):
#
#   - Dockerfile's EXPOSE'd port matches the port both compose files publish
#     the app on.
#   - The healthcheck binary path baked into the runtime image matches what
#     every compose file's healthcheck actually invokes.
#   - deploy/stellargate.env.example never carries a real-looking secret in
#     place of a placeholder.
#   - Every path named in the README architecture tree actually exists, and no
#     document claims a `migrations/` directory exists (issue #868).
#
# Run locally with: bash scripts/check-deploy-consistency.sh

set -euo pipefail

fail=0
note() { printf '\033[1;31mdrift:\033[0m %s\n' "$*"; fail=1; }

dockerfile_port=$(grep -oE '^EXPOSE [0-9]+' Dockerfile | grep -oE '[0-9]+')
dockerfile_bin=$(grep -oE '/usr/local/bin/[a-z]+' Dockerfile | sort -u | head -1)

for compose in docker-compose.yml deploy/docker-compose.prod.yml; do
    if ! grep -qE "(^|[\"':])${dockerfile_port}([\"'/:]|$)" "$compose"; then
        note "$compose does not reference port $dockerfile_port (from Dockerfile EXPOSE)"
    fi
    if ! grep -q "$dockerfile_bin" "$compose"; then
        note "$compose healthcheck does not invoke $dockerfile_bin (from Dockerfile)"
    fi
done

env_example="deploy/stellargate.env.example"
for var in WEBHOOK_SECRET ADMIN_PROVISIONING_SECRET; do
    value=$(grep -E "^${var}=" "$env_example" | head -1 | cut -d= -f2-)
    if [[ -n "$value" && "$value" != REPLACE_ME_* ]]; then
        note "$env_example: $var=$value does not look like the REPLACE_ME_ placeholder"
    fi
done

# README architecture tree must not drift from the repository (issue #868).
# Extract every path-like token from the fenced architecture block and verify
# it exists on disk. Tokens ending in `/` are treated as directories.
readme="README.md"
if [[ -f "$readme" ]]; then
    arch_block=$(awk '
        /^## Architecture/ { in_section = 1; next }
        in_section && /^```/ { in_fence = !in_fence; next }
        in_section && in_fence { print }
        in_section && !in_fence && /^## / { exit }
    ' "$readme")
    while IFS= read -r token; do
        [[ -z "$token" ]] && continue
        if [[ ! -e "$token" ]]; then
            note "$readme architecture tree names '$token' but it does not exist"
        fi
    done < <(printf '%s\n' "$arch_block" \
        | grep -oE '[A-Za-z0-9_./-]+' \
        | grep -E '(/|\.(rs|js|sql|md|toml|yml|yaml|sh|html|css))$' \
        | sort -u)
fi

# No document may claim a `migrations/` directory exists (issue #308, #868).
for doc in README.md MIGRATIONS.md CONTRIBUTING.md DEPLOYMENT.md; do
    [[ -f "$doc" ]] || continue
    if grep -qE '(^|[^A-Za-z0-9_])migrations/' "$doc"; then
        note "$doc references a migrations/ directory, which was removed in #308"
    fi
done

if [[ $fail -eq 0 ]]; then
    echo "deploy assets are consistent with Dockerfile"
fi
exit $fail
