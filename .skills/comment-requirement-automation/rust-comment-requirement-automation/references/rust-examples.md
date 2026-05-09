# Rust examples

## Database connection with narrower descendant IDs

```rust
// @behavior db.connection The function creates a database connection pool and returns its handle.
pub async fn create_db_pool(config: &DbConfig) -> Result<PgPool, DbError> {
    // @constraint db.connection.invalid_url The branch returns a configuration error when the database URL is invalid.
    let options = config.database_url.parse::<PgConnectOptions>()?;

    // @behavior db.connection.pool_size The expression applies the configured maximum pool size before opening connections.
    let pool = PgPoolOptions::new()
        .max_connections(config.max_connections)
        .connect_with(options)
        .await?;

    Ok(pool)
}
```

The higher-level comment describes the function. The inner comments describe narrower descendant requirements for a specific error case and a specific pool-setting behavior.

## Failure policy

```rust
// @behavior pay.auth.retry The function retries PSP authorization after transient transport failure.
async fn authorize_with_retry(input: AuthorizationInput) -> Result<AuthResult, AuthError> {
    for attempt in 0..MAX_ATTEMPTS {
        // @constraint pay.auth.retry.idempotency The call uses the original idempotency key and cannot create a second authorization record.
        let result = provider.authorize(input.idempotency_key.clone()).await;

        // @behavior pay.auth.retry.timeout The branch returns a pending authorization when all timeout attempts are exhausted.
        if matches!(result, Err(AuthError::Timeout)) && attempt + 1 == MAX_ATTEMPTS {
            return Ok(AuthResult::Pending);
        }
    }

    unreachable!()
}
```

## State machine

```rust
// @behavior order.auth.state The enum records the authorization lifecycle state exposed to order processing.
pub enum AuthorizationState {
    Pending,
    Authorized,
    Failed,
}

// @behavior order.auth.state.pending_to_authorized The function moves a pending authorization to authorized after PSP approval.
fn mark_authorized(state: AuthorizationState) -> AuthorizationState {
    match state {
        // @behavior order.auth.state.pending_to_authorized.arm The match arm converts pending authorization into authorized authorization.
        AuthorizationState::Pending => AuthorizationState::Authorized,
        other => other,
    }
}
```

## Structure intent

```rust
// @intent pay.auth.gateway The trait defines the active authorization boundary shared by Stripe and Adyen providers.
pub trait PaymentGateway {
    async fn authorize(&self, input: AuthorizationInput) -> Result<AuthResult, AuthError>;
}

// @intent pay.auth.gateway.stripe The adapter translates gateway authorization requests into Stripe API calls.
pub struct StripeGateway {
    client: stripe::Client,
}
```

## Test verification

```rust
// @verifies db.connection.invalid_url The test verifies that invalid database URLs return configuration errors.
#[tokio::test]
async fn invalid_database_url_returns_configuration_error() {
    let config = DbConfig { database_url: "not a url".into(), max_connections: 5 };
    let err = create_db_pool(&config).await.unwrap_err();
    assert!(matches!(err, DbError::Config(_)));
}
```
