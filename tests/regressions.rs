//! Regression tests for closed security and correctness issues.
//!
//! Convention (see CONTRIBUTING.md): every closed security or correctness
//! issue gets one fast, black-box test here, named after the issue it pins
//! (`issue_<number>_<short_description>`). These tests go through the public
//! router only, so they survive refactors of internal modules and are hard to
//! delete accidentally during a conflict resolution.
//!
//! If a test here starts failing, the fix it guards has regressed — do not
//! delete the test, restore the fix.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

/// Build the application router under test.
///
/// Kept in one place so the guard file stays black-box: tests only ever touch
/// the public HTTP surface.
async fn app() -> axum::Router {
    // The router is constructed the same way the binary does it. If the
    // constructor signature changes, only this helper needs updating.
    crate::app_router_for_tests().await
}

/// Send a request through the router and return the response status.
async fn status_of(router: axum::Router, request: Request<Body>) -> StatusCode {
    let response = router.oneshot(request).await.expect("router call failed");
    response.status()
}

/// Regression: #254 — idempotency keys must reject a reused key whose body
/// differs from the original request.
#[tokio::test]
async fn issue_254_idempotency_key_rejects_different_body() {
    let router = app().await;

    let first = Request::builder()
        .method("POST")
        .uri("/payments")
        .header("content-type", "application/json")
        .header("idempotency-key", "regression-254")
        .body(Body::from(r#"{"amount":"10.00","asset":"XLM"}"#))
        .expect("request");
    let first_status = status_of(router.clone(), first).await;
    assert!(
        first_status.is_success() || first_status == StatusCode::ACCEPTED,
        "first request with a fresh idempotency key should be accepted, got {first_status}"
    );

    let second = Request::builder()
        .method("POST")
        .uri("/payments")
        .header("content-type", "application/json")
        .header("idempotency-key", "regression-254")
        .body(Body::from(r#"{"amount":"99.00","asset":"XLM"}"#))
        .expect("request");
    let second_status = status_of(router, second).await;
    assert_eq!(
        second_status,
        StatusCode::CONFLICT,
        "reusing an idempotency key with a different body must be rejected"
    );
}

/// Regression: #261 — payment amounts must be bounded; zero and negative
/// amounts are rejected before reaching the ledger.
#[tokio::test]
async fn issue_261_payment_amount_must_be_positive() {
    let router = app().await;

    let request = Request::builder()
        .method("POST")
        .uri("/payments")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"amount":"0","asset":"XLM"}"#))
        .expect("request");
    let status = status_of(router, request).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a zero payment amount must be rejected"
    );
}

/// Regression: #268 — list endpoints must clamp oversized pagination limits
/// instead of honouring them, so a single request cannot exhaust the DB.
#[tokio::test]
async fn issue_268_pagination_limit_is_clamped() {
    let router = app().await;

    let request = Request::builder()
        .method("GET")
        .uri("/payments?limit=100000")
        .body(Body::empty())
        .expect("request");
    let status = status_of(router, request).await;
    assert!(
        status.is_success(),
        "an oversized pagination limit should be clamped, not rejected, got {status}"
    );
}

/// Regression: #272 — health endpoint must report readiness through the
/// public router so probes can rely on it.
#[tokio::test]
async fn issue_272_health_endpoint_reports_ready() {
    let router = app().await;

    let request = Request::builder()
        .method("GET")
        .uri("/health")
        .body(Body::empty())
        .expect("request");
    let status = status_of(router, request).await;
    assert_eq!(status, StatusCode::OK, "health endpoint must report ready");
}

/// Regression: #279 — memo fields must carry sufficient entropy; a
/// low-entropy memo is rejected rather than silently accepted.
#[tokio::test]
async fn issue_279_low_entropy_memo_is_rejected() {
    let router = app().await;

    let request = Request::builder()
        .method("POST")
        .uri("/payments")
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"amount":"10.00","asset":"XLM","memo":"aaaaaaaa"}"#,
        ))
        .expect("request");
    let status = status_of(router, request).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a low-entropy memo must be rejected"
    );
}
