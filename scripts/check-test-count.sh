#!/usr/bin/env bash
#
# Regression-test guard (see CONTRIBUTING.md, "Regression tests per issue").
#
# Fails when the number of #[test] / #[tokio::test] functions in the repo
# drops by more than ALLOWED_DROP compared to the base branch, unless the PR
# carries the `test-removal-approved` label.
#
# Usage:
#   scripts/check-test-count.sh <base-ref>
#
# Environment:
#   ALLOWED_DROP            Max number of tests that may disappear (default: 0).
#   TEST_REMOVAL_APPROVED   Set to "true" when the PR has the
#                           `test-removal-approved` label.

set -euo pipefail

BASE_REF="${1:-origin/main}"
ALLOWED_DROP="${ALLOWED_DROP:-0}"
TEST_REMOVAL_APPROVED="${TEST_REMOVAL_APPROVED:-false}"

count_tests() {
    # Count `#[test]` and `#[tokio::test]` attributes across Rust sources.
    # Matches the attribute even when followed by other attributes/args.
    grep -rEHo '^[[:space:]]*#\[(tokio::)?test(\([^)]*\))?\]' \
        --include='*.rs' . 2>/dev/null | wc -l | tr -d '[:space:]'
}

if ! git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
    echo "check-test-count: base ref '${BASE_REF}' not found; skipping guard."
    exit 0
fi

CURRENT_COUNT="$(count_tests)"

# Count tests on the base ref without disturbing the working tree.
BASE_COUNT="$(
    git grep -EHo '^[[:space:]]*#\[(tokio::)?test(\([^)]*\))?\]' \
        "${BASE_REF}" -- '*.rs' 2>/dev/null | wc -l | tr -d '[:space:]'
)"

if [ -z "${BASE_COUNT}" ]; then
    BASE_COUNT=0
fi

DROP=$((BASE_COUNT - CURRENT_COUNT))

echo "check-test-count: base=${BASE_COUNT} current=${CURRENT_COUNT} drop=${DROP} allowed=${ALLOWED_DROP}"

if [ "${DROP}" -le "${ALLOWED_DROP}" ]; then
    echo "check-test-count: OK"
    exit 0
fi

if [ "${TEST_REMOVAL_APPROVED}" = "true" ]; then
    echo "check-test-count: ${DROP} tests removed, approved via test-removal-approved label."
    exit 0
fi

echo "check-test-count: ERROR: ${DROP} test(s) were removed (allowed: ${ALLOWED_DROP})." >&2
echo "Regression tests pin closed issues; deleting them hides regressions." >&2
echo "If removal is intentional, add the 'test-removal-approved' label to the PR." >&2
exit 1
