//! StellarGate binary entry point: boots configuration, storage and HTTP
//! clients, spawns the background listeners, serves the API, and drains
//! everything on shutdown.

use anyhow::Result;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use stellargate::{
    AppState, TaskHealth, api,
    config::{Config, ListenerMode},
    db, expiry, horizon,
    metrics::{
        AuthMetrics, HorizonMetrics, HttpMetrics, PaymentMetrics, TrustlineMetrics, WebhookMetrics,
    },
    retention, webhook,
};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const USER_AGENT: &str = concat!("StellarGate/", env!("CARGO_PKG_VERSION"));

/// Timeout for general outbound HTTP (Horizon). Webhook delivery uses its own
/// configurable per-attempt timeout instead.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// How long shutdown waits for background tasks to drain before forcing exit.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

/// Timeout for the `healthcheck` subcommand's probe request. Kept short so a
/// hung server fails the probe quickly instead of stalling the orchestrator.
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Default probe path when the subcommand is invoked without one.
const HEALTHCHECK_DEFAULT_PATH: &str = "health";

#[tokio::main]
async fn main() -> Result<()> {
    // Handle the `healthcheck` subcommand before anything else: no config
    // loading, tracing init, DB open, migrations, Horizon calls, or port
    // binding. Container probes must not start a second server.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("healthcheck") {
        let path = args
            .get(2)
            .map(String::as_str)
            .unwrap_or(HEALTHCHECK_DEFAULT_PATH);
        let code = run_healthcheck(path).await;
        std::process::exit(code);
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    dotenvy::dotenv().ok();

    let cfg = Config::from_env()?;
    // `open_pool` builds every connection through `db::connect_options`, which
    // enables `PRAGMA foreign_keys = ON`, so referential integrity is enforced
    // on each pooled connection without any extra setup here.
    let pool = db::open_pool(
        &cfg.database_url,
        cfg.db_pool_max_connections,
        Duration::from_millis(cfg.db_busy_timeout_ms),
    )
    .await?;
    db::migrate(&pool).await?;
    /* One-off, best-effort reconstruction of `payments.asset_issuer` for rows
    created before the column existed. Needs the accepted-asset allow-list, so
    it runs here rather than inside `migrate`. */
    db::backfill_asset_issuers(&pool, &cfg.accepted_assets).await?;

    let state = Arc::new(AppState {
        pool,
        http: http_client(HTTP_TIMEOUT)?,
        webhook_http: http_client(Duration::from_secs(cfg.webhook_timeout_secs))?,
        webhook_metrics: WebhookMetrics::new(),
        auth_metrics: AuthMetrics::new(),
        horizon_metrics: HorizonMetrics::new(),
        trustline_metrics: TrustlineMetrics::new(),
        http_metrics: HttpMetrics::new(),
        payment_metrics: PaymentMetrics::new(),
        task_health: TaskHealth::new(),
        config: cfg,
    });

    if state.config.gateway_configured() {
        report_trustlines(&state).await;
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let health = state.task_health.clone();

    let stream = (state.config.listener_mode == ListenerMode::Stream).then(|| {
        spawn_task(
            &health,
            "stream",
            horizon::run_stream_listener(state.clone(), shutdown_rx.clone()),
        )
    });
    let poller = spawn_task(
        &health,
        "poller",
        horizon::run_poller(state.clone(), shutdown_rx.clone()),
    );
    let sweeper = spawn_task(
        &health,
        "sweeper",
        expiry::run_sweeper(state.clone(), shutdown_rx.clone()),
    );
    let retention = spawn_task(
        &health,
        "retention",
        retention::run_retention_worker(state.clone(), shutdown_rx.clone()),
    );
    let trustline_checker = spawn_task(&health, "trustline_checker", {
        let state = state.clone();
        let shutdown_rx = shutdown_rx.clone();
        async move {
            horizon::run_trustline_checker(state, shutdown_rx).await;
        }
    });
    let redrive = spawn_task(
        &health,
        "redrive",
        webhook::run_redrive_worker(state.clone(), shutdown_rx),
    );

    let addr = format!("0.0.0.0:{}", state.config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("StellarGate API listening on {addr}");

    axum::serve(
        listener,
        api::router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    let _ = shutdown_tx.send(true);
    let drain = async {
        join_task(poller, "poller", &health).await;
        join_task(sweeper, "sweeper", &health).await;
        join_task(redrive, "redrive", &health).await;
        join_task(retention, "retention", &health).await;
        join_task(trustline_checker, "trustline_checker", &health).await;
        if let Some(handle) = stream {
            join_task(handle, "stream", &health).await;
        }
    };
    if tokio::time::timeout(SHUTDOWN_GRACE, drain).await.is_err() {
        info!(
            timeout_secs = SHUTDOWN_GRACE.as_secs(),
            "background tasks did not drain in time; forcing exit"
        );
    }

    info!("shutdown complete");
    Ok(())
}

/// Build the probe URL for the `healthcheck` subcommand. Trims any leading
/// slashes from `path` so both `health` and `/health` produce the same URL.
fn healthcheck_url(port: u16, path: &str) -> String {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() {
        HEALTHCHECK_DEFAULT_PATH
    } else {
        path
    };
    format!("http://127.0.0.1:{port}/{path}")
}

/// Probe the local server's health endpoint and return the process exit code:
/// `0` when the endpoint answers with a success status, `1` otherwise.
async fn run_healthcheck(path: &str) -> i32 {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3000);
    let url = healthcheck_url(port, path);

    let client = match reqwest::Client::builder()
        .timeout(HEALTHCHECK_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            eprintln!("healthcheck: failed to build HTTP client: {e}");
            return 1;
        }
    };

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => 0,
        Ok(resp) => {
            eprintln!("healthcheck: {url} returned {}", resp.status());
            1
        }
        Err(e) => {
            eprintln!("healthcheck: {url} failed: {e}");
            1
        }
    }
}

fn http_client(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .build()?)
}

/// Report whether every accepted asset has a trustline on the gateway account.
/// Advisory only: a missing trustline doesn't block boot, it just means
/// payments in that asset will bounce until the trustline is added.
async fn report_trustlines(state: &Arc<AppState>) {
    match horizon::check_trustlines(state).await {
        Ok(missing) if missing.is_empty() => {
            info!("gateway trustlines verified for all accepted assets")
        }
        Ok(missing) => info!(
            ?missing,
            "accepted assets with no trustline on the gateway account"
        ),
        Err(e) => warn!(error = %e, "could not verify gateway trustlines at startup"),
    }
}

/// Spawn a background task, keeping [`TaskHealth`] accurate across its
/// lifetime: counted as started before it runs and as stopped when it returns
/// normally. A panic is recorded instead by [`join_task`] at shutdown.
fn spawn_task<F>(health: &TaskHealth, name: &'static str, task: F) -> JoinHandle<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let health = health.clone();
    health.task_started(name);
    tokio::spawn(async move {
        task.await;
        health.task_stopped(name);
    })
}

/// Await a background task. A `JoinError` means it panicked, which is recorded
/// so the failure counter — and any alert watching it — fires.
async fn join_task(handle: JoinHandle<()>, name: &'static str, health: &TaskHealth) {
    if let Err(e) = handle.await
        && e.is_panic()
    {
        warn!("background task panicked");
        health.task_failed(name);
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            tracing::warn!(error = %err, "failed to install Ctrl-C handler");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => {
                tracing::warn!(error = %err, "failed to install SIGTERM handler");
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthcheck_url_uses_port_and_path() {
        assert_eq!(
            healthcheck_url(3000, "health"),
            "http://127.0.0.1:3000/health"
        );
        assert_eq!(
            healthcheck_url(8080, "ready"),
            "http://127.0.0.1:8080/ready"
        );
    }

    #[test]
    fn healthcheck_url_trims_leading_slashes() {
        assert_eq!(
            healthcheck_url(3000, "/health"),
            "http://127.0.0.1:3000/health"
        );
        assert_eq!(
            healthcheck_url(3000, "///ready"),
            "http://127.0.0.1:3000/ready"
        );
    }

    #[test]
    fn healthcheck_url_falls_back_to_default_path() {
        assert_eq!(
            healthcheck_url(3000, ""),
            "http://127.0.0.1:3000/health"
        );
        assert_eq!(
            healthcheck_url(3000, "/"),
            "http://127.0.0.1:3000/health"
        );
    }
}
