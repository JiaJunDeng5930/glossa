# TypeScript examples

## Database connection with deeper IDs

```ts
// @behavior db.connection The function creates a database connection pool and returns its handle.
export async function createDbPool(config: DbConfig): Promise<Pool> {
  // @constraint db.connection.invalid_url The branch returns a configuration error when the database URL is invalid.
  const url = parseDatabaseUrl(config.databaseUrl);

  // @behavior db.connection.pool_size The expression applies the configured maximum pool size before opening connections.
  return createPool({ url, max: config.maxConnections });
}
```

The function comment states the local function requirement. The inner comments state narrower requirements for a specific error case and a specific pool-setting behavior.

## Failure policy

```ts
// @behavior pay.auth.retry The function retries PSP authorization after transient transport failure.
async function authorizeWithRetry(input: AuthorizationInput): Promise<AuthResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // @constraint pay.auth.retry.idempotency The call uses the original idempotency key and cannot create a second authorization record.
    const result = await provider.authorize({ idempotencyKey: input.idempotencyKey });

    // @behavior pay.auth.retry.timeout The branch returns a pending authorization when all timeout attempts are exhausted.
    if (result.kind === "timeout" && attempt + 1 === MAX_ATTEMPTS) return { kind: "pending" };
  }

  throw new Error("unreachable");
}
```

## State machine

```ts
// @behavior order.auth.state The type records the authorization lifecycle state exposed to order processing.
export type AuthorizationState = "pending" | "authorized" | "failed";

// @behavior order.auth.state.pending_to_authorized The function moves a pending authorization to authorized after PSP approval.
function markAuthorized(state: AuthorizationState): AuthorizationState {
  switch (state) {
    // @behavior order.auth.state.pending_to_authorized.case The case converts pending authorization into authorized authorization.
    case "pending":
      return "authorized";
    default:
      return state;
  }
}
```

## Structure intent

```ts
// @intent pay.auth.gateway The interface defines the active authorization boundary shared by Stripe and Adyen providers.
export interface PaymentGateway {
  authorize(input: AuthorizationInput): Promise<AuthResult>;
}

// @intent pay.auth.gateway.stripe The adapter translates gateway authorization requests into Stripe API calls.
export class StripeGateway implements PaymentGateway {
  async authorize(input: AuthorizationInput): Promise<AuthResult> {
    return stripeClient.authorize(input);
  }
}
```

## Test verification

```ts
// @verifies db.connection.invalid_url The test verifies that invalid database URLs return configuration errors.
it("returns a configuration error for invalid database URLs", async () => {
  await expect(createDbPool({ databaseUrl: "not a url", maxConnections: 5 })).rejects.toThrow(ConfigError);
});
```
