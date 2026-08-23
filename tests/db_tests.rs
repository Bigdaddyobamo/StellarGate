use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;
use stellargate::db;

#[tokio::test]
async fn migration_rolls_back_schema_changes_when_backfill_fails() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::from_str("sqlite::memory:")
                .unwrap()
                .create_if_missing(true),
        )
        .await
        .unwrap();

    sqlx::query(
        "CREATE TABLE payments (
            id TEXT PRIMARY KEY,
            merchant_id TEXT NOT NULL DEFAULT 'anonymous',
            destination_address TEXT NOT NULL,
            memo TEXT NOT NULL UNIQUE,
            amount TEXT NOT NULL,
            asset TEXT NOT NULL DEFAULT 'XLM',
            status TEXT NOT NULL DEFAULT 'pending',
            webhook_url TEXT,
            tx_hash TEXT,
            paid_amount TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO payments
            (id, destination_address, memo, amount, created_at, updated_at)
         VALUES ('payment-1', 'destination', 'memo-1', '10',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_expiry_backfill
         BEFORE UPDATE ON payments
         WHEN NEW.created_at = OLD.created_at
         BEGIN
             SELECT RAISE(ABORT, 'injected migration failure');
         END",
    )
    .execute(&pool)
    .await
    .unwrap();

    assert!(db::migrate(&pool).await.is_err());

    let expires_at_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('payments') WHERE name = 'expires_at'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(expires_at_columns, 0);

    let committed_tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name IN
             ('webhook_deliveries', 'kv_state', 'merchants',
              'idempotency_keys', 'processed_transactions')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(committed_tables, 0);
}
