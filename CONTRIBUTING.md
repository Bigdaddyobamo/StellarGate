# Contributing

Thanks for taking the time to contribute. This document covers the conventions we expect in pull requests.

## Getting started

1. Fork the repository and create a topic branch off `main`.
2. Make your change, keeping the diff focused on a single concern.
3. Run the test suite locally before opening a PR.
4. Open a pull request describing the change and the issue it addresses.

## Regression test per issue

Every fix for a closed security or correctness issue must land with a test that pins the behaviour and references the issue number. This is how we prevent a future revert from silently deleting both the fix and its coverage.

- **Name tests after the issue they pin.** For example:

  ```rust
  #[tokio::test]
  async fn issue_254_idempotency_key_rejects_different_body() {
      // ...
  }
  ```

  Alternatively, keep a descriptive name and add a doc comment:

  ```rust
  /// Regression: #254
  #[test]
  fn idempotency_key_rejects_different_body() {
      // ...
  }
  ```

- **Prefer the guard file.** `tests/regressions.rs` holds one fast, black-box test per closed security or correctness issue, exercising the public router only. A single file is much harder to lose in a conflict resolution than tests spread across many modules. Add new regression tests there unless the behaviour genuinely needs a unit test inside `src/`.

- **Do not delete tests without approval.** CI runs a test-count guard that fails a pull request when the number of `#[test]` / `#[tokio::test]` functions drops by more than the allowed threshold. If a test removal is intentional, apply the `test-removal-approved` label to the PR and explain the removal in the description.

## Pull request checklist

- [ ] The change is scoped to the linked issue.
- [ ] New or restored behaviour is covered by a test that references its issue number (e.g. `issue_254_...` or `/// Regression: #254`).
- [ ] No tests were removed, or the `test-removal-approved` label is applied and the removal is justified.
- [ ] The test suite passes locally.
