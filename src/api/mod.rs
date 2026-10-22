use crate::api::payments::{AppError, JsonBody};
use crate::{AppState, db};
use axum::{
    Json,
    extract::{ConnectInfo, Extension, Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
};
use governor::clock::{Clock, DefaultClock};
use governor::middleware::StateInformationMiddleware;
use ipnet::IpNet;
use moka::sync::Cache;
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;
use tower_http::{
    cors::CorsLayer,
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

mod payments;

/// Reject request bodies larger than this (256 KiB) before they hit a handler.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// The authenticated merchant ID injected by the auth middleware.
#[derive(Clone)]
pub struct AuthenticatedMerchant(pub String);

/// Maximum number of distinct IP+bucket keys tracked at once.
/// Once this is reached, moka evicts the least-recently-used entry,
/// bounding resident memory regardless of key cardinality.
const RATE_LIMITER_MAX_KEYS: u64 = 10_000;

/// How long a per-key limiter is retained after its last access.
/// Keys for IPs that go quiet are automatically reclaimed.
const RATE_LIMITER_IDLE_TTL: Duration = Duration::from_secs(60);

/// Sentinel returned by `client_ip_key` when no peer address and no trusted
/// forwarding headers are available. Every such request shares this single
/// key so a caller cannot mint arbitrarily many limiter buckets by varying a
/// header — the safe, fail-closed behaviour.
pub(crate) const CLIENT_IP_UNKNOWN: &str = "unknown";

#[derive(Clone)]
struct RateLimitState {
    requests_per_sec: u32,
    /// Bounded, TTL-evicting cache of per-(bucket, IP) rate limiters.
    ///
    /// Replaces the previous `Mutex<HashMap<...>>`:
    /// - Capacity is capped at `RATE_LIMITER_MAX_KEYS` entries (moka evicts
    ///   via a W-TinyLFU policy when the cap is hit).
    /// - Each entry expires `RATE_LIMITER_IDLE_TTL` after its last access,
    ///   so limiter state for quiet IPs is automatically reclaimed.
    /// - moka uses internal sharding, eliminating the single global lock that
    ///   the old `Mutex` imposed.
    limiters: Cache<String, Arc<governor::DefaultDirectRateLimiter<StateInformationMiddleware>>>,
    /// CIDR blocks trusted to supply `X-Forwarded-For` / `X-Real-IP`, copied
    /// from `Config` at startup so the middleware can attribute each request
    /// to the real client (issue #330).
    trusted_proxies: Vec<IpNet>,
}

const X_RATELIMIT_LIMIT: HeaderName = HeaderName::from_static("x-ratelimit-limit");
const X_RATELIMIT_REMAINING: HeaderName = HeaderName::from_static("x-ratelimit-remaining");
const X_RATELIMIT_RESET: HeaderName = HeaderName::from_static("x-ratelimit-reset");

impl RateLimitState {
    fn new(requests_per_sec: u32, trusted_proxies: Vec<IpNet>) -> Self {
        let limiters = Cache::builder()
            .max_capacity(RATE_LIMITER_MAX_KEYS)
            .time_to_idle(RATE_LIMITER_IDLE_TTL)
            .build();
        Self {
            requests_per_sec: requests_per_sec.max(1),
            limiters,
            trusted_proxies,
        }
    }
}

/// Per-merchant limiter guarding `POST /payments/{id}/webhooks/{delivery_id}/redeliver`
/// (issue #468).
///
/// The IP-keyed `"redeliver"` bucket in [`rate_limit_middleware`] already
/// bounds this endpoint, but only per source address. A single authenticated
/// merchant issuing requests from many addresses (rotating egress IPs, a
/// pool of workers, a proxy fleet) is not bound by it at all, and could
/// otherwise drive an unbounded redelivery storm against their own webhook
/// endpoint — or, since the request is made with our outbound client, look
/// like one against a downstream receiver. Keying on [`AuthenticatedMerchant`]
/// instead closes that gap regardless of how many addresses a merchant's
/// traffic comes from.
///
/// Deliberately separate from `RateLimitState`: it runs only inside
/// `payments_authed`, after `auth_middleware` has populated the
/// [`AuthenticatedMerchant`] extension, so it can be keyed on merchant
/// identity rather than address.
#[derive(Clone)]
struct MerchantRedeliverLimitState {
    requests_per_sec: u32,
    limiters: Cache<String, Arc<governor::DefaultDirectRateLimiter>>,
}

impl MerchantRedeliverLimitState {
    fn new(requests_per_sec: u32) -> Self {
        let limiters = Cache::builder()
            .max_capacity(RATE_LIMITER_MAX_KEYS)
            .time_to_idle(RATE_LIMITER_IDLE_TTL)
            .build();
        Self {
            requests_per_sec: requests_per_sec.max(1),
            limiters,
        }
    }
}

/* Every `from_fn` / `from_fn_with_state` middleware in this module uses the
`(State<_>?, extractors…, req: Request, next: Next) -> Response` shape, with
the non-generic `Next` and `axum::extract::Request` (= `Request<Body>`). That
is the form axum 0.8 requires, so none of them need changing for the upgrade
(issue #634); keep new middleware to the same shape. */

/// Rejects a redelivery request once the calling merchant has exceeded their
/// share of `RATE_LIMIT_REQUESTS_PER_SEC` on this endpoint, independent of
/// which address(es) the requests arrive from. Must run after
/// `auth_middleware` — it requires the [`AuthenticatedMerchant`] extension.
async fn merchant_redeliver_limit_middleware(
    State(limit): State<MerchantRedeliverLimitState>,
    Extension(AuthenticatedMerchant(merchant_id)): Extension<AuthenticatedMerchant>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    let limiter = limit.limiters.get_with(merchant_id, || {
        Arc::new(governor::RateLimiter::direct(governor::Quota::per_second(
            NonZeroU32::new(limit.requests_per_sec)
                .expect("requests_per_sec is clamped to at least 1"),
        )))
    });

    if let Err(not_until) = limiter.check() {
        let wait = not_until.wait_time_from(DefaultClock::default().now());
        let retry_after = retry_after_secs(wait);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(
                header::RETRY_AFTER,
                HeaderValue::from_str(&retry_after.to_string())
                    .unwrap_or_else(|_| HeaderValue::from_static("1")),
            )],
            Json(json!({
                "error": "rate limit exceeded",
                "code": "rate_limit_exceeded"
            })),
        )
            .into_response();
    }

    next.run(req).await
}

pub fn router(state: Arc<AppState>) -> axum::Router {
    let cors = build_cors(&state.config);
    let rate_limit = RateLimitState::new(
        state.config.rate_limit_requests_per_sec,
        state.config.trusted_proxy_cidrs.clone(),
    );
    // Constructed once and shared across both the `/v1` and legacy mounts
    // (`api_v1` is called for each) so a merchant's quota is a single pool
    // regardless of which prefix they call through — matching how the IP-keyed
    // `rate_limit` bucket above is already shared across both mounts.
    let merchant_redeliver_limit =
        MerchantRedeliverLimitState::new(state.config.rate_limit_requests_per_sec);
    let request_timeout = Duration::from_secs(state.config.request_timeout_secs);
    let hsts = hsts_value(&state.config.network);

    axum::Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/ready", get(ready))
        /* Gated behind METRICS_TOKEN (issue #250) — unset by default, which
        denies every request rather than exposing auth/webhook counters
        anonymously. See `require_metrics_token`. */
        .route(
            "/metrics",
            get(metrics_handler).route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_metrics_token,
            )),
        )
        /* Operator dashboard. The assets are static and carry no data, so they
        are served unauthenticated — every figure they display is fetched by
        the browser from the same authenticated endpoints a merchant would
        call directly, using an API key the operator supplies. */
        .route("/dashboard/admin", get(dashboard_admin_html))
        .route("/dashboard/admin.js", get(dashboard_admin_js))
        .route("/dashboard", get(dashboard_html))
        .route("/dashboard/app.css", get(dashboard_css))
        .route("/dashboard/app.js", get(dashboard_js))
        .route("/dashboard/i18n.js", get(dashboard_i18n))
        .route("/dashboard/format.js", get(dashboard_format_js))
        /* The dashboard is split into DOM-free modules so their logic can be
        unit tested with `node --test` (issue #723). Each is still an
        individually allow-listed route: an unknown file under
        /dashboard/ falls through to the JSON 404 and is never read from
        disk, so nothing under static/ is exposed by accident. */
        .route("/dashboard/session.js", get(dashboard_session_js))
        .route("/dashboard/state.js", get(dashboard_state_js))
        .route("/dashboard/keys.js", get(dashboard_keys_js))
        .route("/dashboard/vendor/qrcode.js", get(dashboard_qrcode_js))
        .route("/dashboard/theme.js", get(dashboard_theme_js))
        /* The versioned API surface, mounted twice.
        `/v1` is canonical. The same routes stay mounted unprefixed so every
        existing integrator keeps working — shipping versioning by breaking all
        current callers at once would be precisely the failure versioning
        exists to prevent (issue #121). Legacy responses carry `Deprecation`
        and `Link` headers pointing at their `/v1` equivalent, so a client can
        discover the move from a response it already parses. */
        .nest("/v1", api_v1(&state, merchant_redeliver_limit.clone()))
        .merge(api_v1(&state, merchant_redeliver_limit).layer(middleware::from_fn(mark_deprecated)))
        .fallback(not_found)
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            rate_limit,
            rate_limit_middleware,
        ))
        .layer(cors)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            request_timeout,
        ))
        /* Baseline security headers on every response, not just the static
        dashboard assets. Every JSON response — a payment record, a freshly
        minted API key, a webhook URL — was previously sent with no headers
        at all, leaving it MIME-sniffable, cacheable, and free to leak ids
        through referrers. Applied outermost so they also cover responses the
        inner layers generate (rate-limit 429s, timeout 408s, and the router's
        404/405 fallbacks).
        `nosniff` and `referrer-policy` override any inner value because a
        stricter setting elsewhere is never correct (payment ids travel in
        URLs). `cache-control` is `if_not_present` so a handler that
        legitimately opts in to caching is not blindly clobbered, while the
        API endpoints — which return a plaintext key once, or payment detail —
        get `no-store` by default. Only `Strict-Transport-Security` is
        conditional: TLS is terminated at Caddy and the app cannot assert HSTS
        with any confidence on a testnet where that termination is absent.
        The dashboard's Content-Security-Policy is left untouched. */
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::HeaderName::from_static("strict-transport-security"),
            hsts,
        ))
        .with_state(state)
}

/// The `Strict-Transport-Security` header value, or none on non-public
/// networks. TLS is terminated by the reverse proxy in front of the app, so
/// asserting HSTS is only meaningful where that termination is guaranteed to
/// exist — on a `public` network deployment. On testnet (no enforced TLS) a
/// `max-age` HSTS header would be sent to browsers over plain HTTP, where it
/// is ignored but still misleading; returning `None` lets the caller keep the
/// header absent entirely.
fn hsts_value(network: &str) -> Option<HeaderValue> {
    (network == "public").then(|| HeaderValue::from_static("max-age=63072000; includeSubDomains"))
}

/// The versioned API surface: everything that forms the public contract.
///
/// Operational endpoints (`/health`, `/ready`, `/metrics`, `/dashboard`, `/`)
/// are deliberately excluded. They are infrastructure rather than contract —
/// a probe URL that moved with every API revision would break liveness checks
/// and scrape configs for no benefit.
fn api_v1(
    state: &Arc<AppState>,
    merchant_redeliver_limit: MerchantRedeliverLimitState,
) -> axum::Router<Arc<AppState>> {
    /* Merchant provisioning and API key lifecycle. All admin-gated behind
    ADMIN_PROVISIONING_SECRET: this service has no self-service signup, and
    minting or revoking a credential is an operator action. The admin layer
    goes on each `MethodRouter` for the same reason as the merchant auth layer
    below — a 405 on a known path stays a 405 rather than becoming a 401. */
    let admin_layer = || middleware::from_fn_with_state(state.clone(), require_admin_secret);
    let merchants = axum::Router::new()
        .route("/", post(provision_merchant).route_layer(admin_layer()))
        .route(
            "/{id}/keys",
            post(issue_api_key)
                .get(list_api_keys)
                .route_layer(admin_layer()),
        )
        .route(
            "/{id}/keys/{key_id}",
            axum::routing::delete(revoke_api_key).route_layer(admin_layer()),
        );

    /* Auth middleware on the write + list routes and the webhook listing.
    The per-payment status endpoint handles credentials itself, because it
    serves both authenticated and anonymous callers — see
    `payments::get_by_id`.

    The auth layer is attached to each `MethodRouter` rather than to the
    enclosing `Router` with `route_layer`. That distinction is what decides
    whether a wrong method on a known path answers 405 or 401 (#635): a
    `route_layer` wraps the `MethodRouter` itself, so it runs *before* axum has
    worked out that the method is not allowed and an anonymous `PUT /payments`
    gets a 401 — which tells an integrator their credentials are bad when
    really their verb is. Layering the methods instead lets axum reject the verb
    first, and the request never reaches the credential check. */
    let authed = |m: axum::routing::MethodRouter<Arc<AppState>>| {
        m.route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
    };

    let payments_authed = axum::Router::new()
        .route("/", authed(post(payments::create).get(payments::list)))
        .route("/{id}/webhooks", authed(get(payments::list_webhooks)));

    /* Redelivery gets its own sub-router so `merchant_redeliver_limit_middleware`
    (issue #468) applies only here, not to every authenticated payments route.
    It triggers a merchant-scoped outbound request, so on top of the auth
    middleware every other route here also gets, it additionally needs a
    limiter keyed on the caller's identity rather than their address —
    layered outside-in as auth (runs first, populates the merchant identity)
    then the merchant limiter (runs second, reads it). The last `route_layer`
    added is the outermost, so auth must stay below the limiter here —
    `test_redeliver_runs_auth_before_merchant_limiter` pins this order. */
    let redeliver = axum::Router::new().route(
        "/{id}/webhooks/{delivery_id}/redeliver",
        post(payments::redeliver_webhook)
            .route_layer(middleware::from_fn_with_state(
                merchant_redeliver_limit,
                merchant_redeliver_limit_middleware,
            ))
            .route_layer(auth_layer()),
    );

    /* The summary aggregates one merchant's payments, so it needs the same
    credential check as the list it summarises. It is layered per method for
    the same reason as `payments_authed` (#635): a `route_layer` here would run
    auth before axum rejected a wrong verb, answering 401 where 405 is correct. */
    let summary = get(payments::summary).route_layer(middleware::from_fn_with_state(
        state.clone(),
        auth_middleware,
    ));

    axum::Router::new().nest("/merchants", merchants).nest(
        "/payments",
        axum::Router::new()
            .merge(payments_authed)
            .merge(redeliver)
            .route("/summary", summary)
            /* `get_by_id` handles its own credential check, because it serves
            both authenticated and anonymous callers — a payer confirming their
              own payment has no API key. See `payments::get_by_id`. */
            .route("/{id}", get(payments::get_by_id)),
    )
}

/// Tag a response served from an unversioned path as deprecated.
///
/// `Deprecation` and `Link: rel="successor-version"` are the RFC 8594 /
/// RFC 8288 way of saying this, so a client can find the replacement in a
/// response it is already parsing rather than by reading release notes.
///
/// No `Sunset` header is emitted. That header is a commitment to a removal
/// date, and inventing one here would announce a promise nobody has made —
/// see the deprecation policy in the README.
async fn mark_deprecated(req: Request, next: Next) -> axum::response::Response {
    let successor = format!("/v1{}", req.uri().path());
    let mut res = next.run(req).await;

    let headers = res.headers_mut();
    headers.insert(
        axum::http::HeaderName::from_static("deprecation"),
        HeaderValue::from_static("true"),
    );
    if let Ok(link) = HeaderValue::from_str(&format!("<{successor}>; rel=\"successor-version\"")) {
        headers.insert(header::LINK, link);
    }
    res
}

/// Authenticates via the `Authorization: Bearer <key>` header, injecting
/// [`AuthenticatedMerchant`] into request extensions on success.
///
/// Every outcome is both logged (`source_ip` + `reason`, at a level matched
/// to severity — failures visible by default, success at `debug` to avoid
/// flooding logs) and counted in `AuthMetrics` (issue #139), so
/// credential-stuffing or a misconfigured client shows up in logs/metrics
/// instead of silently returning 401s.
async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> axum::response::Response {
    let source_ip = client_ip_key(&req, &state.config.trusted_proxy_cidrs);

    let raw_key = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);

    let Some(key) = raw_key else {
        tracing::warn!(
            %source_ip,
            reason = "missing_key",
            "auth denied: missing or malformed Authorization header"
        );
        state.auth_metrics.record_failure_missing_key();
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid Authorization header", "code": "unauthorized" })),
        )
            .into_response();
    };

    match db::find_merchant_by_key(&state.pool, &key).await {
        Ok(Some(merchant_id)) => {
            tracing::debug!(%source_ip, %merchant_id, "auth succeeded");
            state.auth_metrics.record_success();
            req.extensions_mut()
                .insert(AuthenticatedMerchant(merchant_id));
            next.run(req).await
        }
        Ok(None) => {
            tracing::warn!(
                %source_ip,
                reason = "invalid_key",
                "auth denied: API key did not match any merchant"
            );
            state.auth_metrics.record_failure_invalid_key();
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "invalid API key", "code": "unauthorized" })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(%source_ip, error = %e, "auth errored: merchant key lookup failed");
            state.auth_metrics.record_failure_internal_error();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal server error", "code": "internal_error" })),
            )
                .into_response()
        }
    }
}

/// Guards `POST /merchants` with a shared admin secret sent via the
/// `X-Admin-Secret` header. An unset `ADMIN_PROVISIONING_SECRET` disables
/// provisioning entirely rather than leaving the endpoint open.
async fn require_admin_secret(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    let configured = &state.config.admin_provisioning_secret;

    // An empty configured secret means provisioning is disabled — reject
    // immediately without touching any caller-supplied value (issue #244).
    if configured.is_empty() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid admin secret", "code": "unauthorized" })),
        )
            .into_response();
    }

    // Reject a missing or non-UTF-8 header before any comparison.
    let Some(provided) = req
        .headers()
        .get("x-admin-secret")
        .and_then(|v| v.to_str().ok())
    else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid admin secret", "code": "unauthorized" })),
        )
            .into_response();
    };

    // Compare SHA-256 digests in constant time (issue #244).
    //
    // `str` equality short-circuits on the first differing byte, leaking a
    // prefix-match oracle. Hashing both sides with SHA-256 normalises them to
    // fixed-length byte arrays; `==` on `[u8; 32]` uses a fixed-time
    // comparison in the standard library, removing the oracle. Salting is
    // unnecessary here — we are comparing a caller-supplied value against a
    // configured secret, not storing a password.
    use sha2::{Digest, Sha256};
    let provided_digest = Sha256::digest(provided.as_bytes());
    let configured_digest = Sha256::digest(configured.as_bytes());

    if provided_digest != configured_digest {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid admin secret", "code": "unauthorized" })),
        )
            .into_response();
    }

    next.run(req).await
}

/// Guards `GET /metrics` with a shared bearer token sent via the standard
/// `Authorization: Bearer <token>` header (the form Prometheus's own
/// `authorization` scrape config emits, so no custom scrape-config surgery is
/// needed). An unset `METRICS_TOKEN` disables the endpoint entirely rather
/// than leaving the auth/webhook counters it exposes open to anonymous
/// callers (issue #250).
async fn require_metrics_token(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    let configured = &state.config.metrics_token;

    // An empty configured token means scraping is disabled — reject
    // immediately without touching any caller-supplied value, mirroring
    // `require_admin_secret`.
    if configured.is_empty() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid metrics token", "code": "unauthorized" })),
        )
            .into_response();
    }

    // Reject a missing or malformed Authorization header before any comparison.
    let Some(provided) = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid metrics token", "code": "unauthorized" })),
        )
            .into_response();
    };

    // Compare SHA-256 digests in constant time — see `require_admin_secret`
    // for the rationale (issue #244); the same oracle applies here.
    use sha2::{Digest, Sha256};
    let provided_digest = Sha256::digest(provided.as_bytes());
    let configured_digest = Sha256::digest(configured.as_bytes());

    if provided_digest != configured_digest {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid metrics token", "code": "unauthorized" })),
        )
            .into_response();
    }

    next.run(req).await
}

/// `POST /merchants` — provision a new merchant and return its API key once.
/// Requires the `X-Admin-Secret` header (see `require_admin_secret`).
async fn provision_merchant(
    State(state): State<Arc<AppState>>,
    req_parts: Request,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let source_ip = client_ip_key(&req_parts, &state.config.trusted_proxy_cidrs);
    let request_id = request_id(req_parts.headers());

    let merchant_id = uuid::Uuid::new_v4().to_string();
    let (raw_key, prefix) = db::generate_api_key();

    let key_id = db::create_merchant(&state.pool, &merchant_id, &raw_key, &prefix)
        .await
        .map_err(|e| {
            // Issue #125: swallowing this left an operator with a 500 and no
            // way to tell a disk error from a UNIQUE collision.
            tracing::error!(error = %e, "failed to provision merchant");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal server error", "code": "internal_error" })),
            )
        })?;

    tracing::info!(
        audit = true,
        action = "merchant.provision",
        actor = "admin",
        outcome = "created",
        %merchant_id,
        %key_id,
        %source_ip,
        %request_id,
        "merchant provisioned"
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "merchant_id": merchant_id,
            "api_key": raw_key,
            "key_id": key_id,
        })),
    ))
}

/// `POST /merchants/:id/keys` — issue an additional API key.
///
/// Rotation is issue-then-revoke rather than replace-in-place: the new key is
/// live immediately while the old one keeps working, so a merchant can deploy
/// the new credential before retiring the old one and never has a window with
/// no valid key. Admin-gated, like provisioning.
async fn issue_api_key(
    State(state): State<Arc<AppState>>,
    Path(merchant_id): Path<String>,
    body: Option<JsonBody<IssueKeyRequest>>,
) -> Result<impl IntoResponse, AppError> {
    if !db::merchant_exists(&state.pool, &merchant_id).await? {
        return Err(AppError::not_found(
            "merchant_not_found",
            "merchant not found",
        ));
    }

    let label = body.and_then(|JsonBody(b)| b.label);
    if let Some(l) = &label
        && l.len() > 100
    {
        return Err(AppError::bad_request(
            "invalid_label",
            "label exceeds max length of 100 characters",
        ));
    }

    let (raw_key, prefix) = db::generate_api_key();
    let key_id = db::create_api_key(
        &state.pool,
        &merchant_id,
        &raw_key,
        &prefix,
        label.as_deref(),
    )
    .await?;

    tracing::info!(
        audit = true,
        action = "api_key.issue",
        actor = "admin",
        outcome = "issued",
        %merchant_id,
        %key_id,
        "api key issued"
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "key_id": key_id,
            "api_key": raw_key,
            "prefix": prefix,
            "label": label,
        })),
    ))
}

/// `GET /merchants/:id/keys` — list a merchant's keys.
///
/// Returns metadata only. The secret is unrecoverable by design, so this can
/// never leak a usable credential; `prefix` exists so an operator can identify
/// which key to revoke.
async fn list_api_keys(
    State(state): State<Arc<AppState>>,
    Path(merchant_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !db::merchant_exists(&state.pool, &merchant_id).await? {
        return Err(AppError::not_found(
            "merchant_not_found",
            "merchant not found",
        ));
    }

    let keys = db::list_api_keys(&state.pool, &merchant_id).await?;
    Ok(Json(json!({
        "merchant_id": merchant_id,
        "keys": keys.iter().map(|k| json!({
            "key_id": k.id,
            "prefix": k.prefix,
            "label": k.label,
            "created_at": k.created_at,
            "last_used_at": k.last_used_at,
            "revoked_at": k.revoked_at,
            "active": k.revoked_at.is_none(),
        })).collect::<Vec<_>>(),
    })))
}

/// `DELETE /merchants/:id/keys/:key_id` — revoke a key immediately.
///
/// Refuses to revoke a merchant's last active key. Doing so would lock them
/// out of an API that has no self-service recovery, turning a routine
/// revocation into an incident; issue a replacement first.
async fn revoke_api_key(
    State(state): State<Arc<AppState>>,
    Path((merchant_id, key_id)): Path<(String, String)>,
    req_parts: axum::extract::Request,
) -> Result<impl IntoResponse, AppError> {
    // Extract the source IP for audit logging before we consume req_parts.
    let source_ip = client_ip_key(&req_parts, &state.config.trusted_proxy_cidrs);
    let request_id = req_parts
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
        .to_string();

    if !db::merchant_exists(&state.pool, &merchant_id).await? {
        return Err(AppError::not_found(
            "merchant_not_found",
            "merchant not found",
        ));
    }

    // The guard against revoking the last active key is now enforced atomically
    // inside the UPDATE via a subquery (issue #247). The previous
    // check-then-act split (count_active_api_keys → revoke_api_key) could be
    // bypassed by two concurrent revocations of a merchant's two remaining
    // keys: both would read a count of 2, both pass the guard, and both
    // succeed, locking the merchant out. RevokeKeyOutcome::LastActiveKey is
    // returned when the atomic guard fires.
    match db::revoke_api_key(&state.pool, &merchant_id, &key_id).await? {
        db::RevokeKeyOutcome::Revoked => {
            tracing::warn!(
                audit = true,
                action = "api_key.revoke",
                actor = "admin",
                outcome = "revoked",
                %merchant_id,
                %key_id,
                source_ip = %source_ip,
                request_id = %request_id,
                "api key revoked"
            );
            Ok((
                StatusCode::OK,
                Json(json!({ "key_id": key_id, "revoked": true })),
            ))
        }
        db::RevokeKeyOutcome::LastActiveKey => Err(AppError::bad_request(
            "last_active_key",
            "cannot revoke a merchant's only active key — issue a replacement first",
        )),
        db::RevokeKeyOutcome::NotFound => Err(AppError::not_found(
            "key_not_found",
            "no active key with that id for this merchant",
        )),
    }
}

#[derive(serde::Deserialize)]
struct IssueKeyRequest {
    label: Option<String>,
}

async fn rate_limit_middleware(
    State(rate_limit): State<RateLimitState>,
    req: Request,
    next: Next,
) -> axum::response::Response {
    if let Some(bucket) = rate_limited_bucket(&req) {
        let key = rate_limit_key(bucket, &req, &rate_limit.trusted_proxies);
        let base_rps = rate_limit.requests_per_sec;
        let effective_rps = base_rps
            .saturating_mul(bucket_rate_multiplier(bucket))
            .max(1);
        /* `get_with` clones the `Arc` out of the cache rather than handing back a
        guard, so nothing borrowed from the cache is held across the `.await`
       
