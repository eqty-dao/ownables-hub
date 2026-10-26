![Ownables Hub](https://user-images.githubusercontent.com/100821/196711741-96cd4ba5-932a-4e95-b420-42d4d61c21fd.png)

# Ownables Hub

Canonical backend service for storing, validating, indexing, and distributing Ownables on Base-focused EVM networks.

The Hub is not just a file host. It accepts uploaded Ownable archives, validates them against anchored and public event history, stores package and chain data separately, derives recipient availability, exposes that availability to wallets for discovery and import, and returns indexed event data so clients can verify Ownables independently.

## What this service does

- Accepts uploaded Ownable archives and validates them before making them available
- Stores package artifacts and canonical Ownable chain data separately
- Indexes relevant Anchor-contract EVM events for server-side and wallet-side verification
- Tracks and exposes public events needed to replay and verify Ownable state
- Derives which owner account an Ownable is currently available to
- Exposes Hub-backed recipient discovery for wallet import flows
- Serves Ownable bundle downloads, including `chain.json`, and indexed event history

## Product model

The current Hub model is built around validation and discovery rather than messaging.

- Sender-side transfer appends the private transfer event locally, then uploads the resulting archive to Hub
- Hub validates and replays the uploaded Ownable instead of writing private events itself
- Hub derives recipient availability from the resulting Ownable state
- Recipient wallets discover available Ownables directly from the Hub
- Wallets can fetch indexed anchor/public events from the Hub to perform their own verification

The Hub is intentionally **not**:

- a generic mailbox between wallets
- a notification product
- a pure file server
- a service that writes private Ownable history on behalf of wallets

## Verification and indexing

The Hub is a verification boundary as much as a storage boundary.

It persistently indexes the relevant EVM events emitted through the Anchor contract. Those indexed events are used internally to validate uploaded Ownables against anchored history, and are also exposed so SDK wallets can independently verify that an Ownable's chain is consistent with the same anchor history.

In addition to anchor events, the Hub tracks and exposes public events. Together, the Ownable's chain, indexed anchor events, and public events provide the replay inputs needed to determine effective Ownable state, detect stale uploads, derive the current owner, and support import flows.

## Identity model

The Hub keeps package identity and Ownable identity distinct.

- Package CID identifies a specific package artifact
- Ownable identity identifies the Ownable instance
- Recipient availability and transfer semantics are keyed by Ownable identity, not only by package CID

This distinction is important for discovery, replay, and import, especially once multiple artifacts or versions are involved.

## Installation

```bash
yarn install
```

Built with [NestJS](https://nestjs.com/).

### Ownables service API migration

The Hub consumes the breaking class-based Ownables API through Nest injection. Package CID calculation remains
a direct `calculateOwnablePackageCid` utility call from `@ownables/core/utils`; anchor validation and public-event
replay are Nest-managed service instances used by `OwnableReplayService` to create the per-archive runtime graph.
Legacy root function imports and positional `OwnableService` construction are intentionally unsupported.

## Authentication (SIWE)

Protected hub routes use SIWE-authenticated request context.

- `POST /api/v1/auth/nonce` returns nonce
- `POST /api/v1/auth/verify` verifies SIWE payload and returns bearer token
- Send `Authorization: Bearer <base64-json-token>` for protected endpoints

Config:

- `SIWE_DOMAIN=<expected-domain>` sets accepted SIWE domain

## Key API routes

Operational routes:

- `GET /` redirect to API documentation
- `GET /info` basic service metadata
- `GET /health` readiness and dependency health

Auth routes:

- `POST /api/v1/auth/nonce` generate SIWE nonce
- `POST /api/v1/auth/verify` verify SIWE payload and return bearer token

Ownable routes:

- `POST /ownables` upload an Ownable package in multipart field `file`. A successful creation returns `201`, the existing response body, and `Location: /ownables/{ownableId}`.
- `GET /ownables/:id/bundle` download the stored Ownable bundle. It contains the canonical `chain.json`.
- `GET /ownables/:id/verification` read the Hub verification report.
- `GET /ownables/:id/public-events` read indexed public events for one Ownable.

Resource collection routes:

- `GET /accounts/:account/available-ownables` list local/dev-only Hub-available Ownables for one CAIP-10 account when explicitly enabled.
- `GET /accounts/:account/available-ownables/events` receive live `available-ownable` SSE events for that account.
- `GET /public-events?ownableId=<id>&ownableId=<id>&fromBlock=<block>` receive indexed `public-event` SSE events. One or more `ownableId` values are required and `fromBlock` defaults to `0`.
- `GET /hub/wallet/:network` read the public Hub signer address and native balance for `eip155:ethereum`, `eip155:arbitrum`, `eip155:polygon`, or `eip155:base`.

Swagger: `http://localhost:3000/api-docs`

## Local Postgres + migrations

Runtime requires `DATABASE_URL` and does not fall back to libpq defaults.
Runtime storage uses `OWNABLES_STORAGE` if set, and defaults to `file://storage` when unset.

Use the local dev startup flow:

```bash
yarn db:start
```

`yarn db:start` is rerunnable and will:
- create or start a local Docker Postgres container
- keep data in a persistent Docker volume
- run `yarn db:migrate:up` against `DATABASE_URL`
- print the exact local `DATABASE_URL` used for migration

Default local settings (override with env vars):
- `HUB_DB_CONTAINER=ownables-hub-postgres`
- `HUB_DB_VOLUME=ownables-hub-postgres-data`
- `HUB_DB_PORT=54329`
- `HUB_DB_NAME=ownables_hub`
- `HUB_DB_USER=ownables`
- `HUB_DB_PASSWORD=ownables`
- `HUB_LOCAL_DATABASE_URL` can override the derived local DSN used by `db:start`
- derived default `DATABASE_URL=postgres://ownables:ownables@127.0.0.1:54329/ownables_hub`
- `HUB_DB_READY_TIMEOUT_SECONDS` readiness timeout for existing containers (default `60`)
- `HUB_DB_COLD_START_TIMEOUT_SECONDS` readiness timeout for new containers (default `240`)

Run migrations directly (for existing Postgres targets):

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db yarn db:migrate:up
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db yarn db:migrate:down
```

## Start app locally

`yarn db:start` only boots Postgres and runs migrations. Start the app with runtime env vars:

```bash
DATABASE_URL=postgres://ownables:ownables@127.0.0.1:54329/ownables_hub \
OWNABLES_STORAGE=file://storage \
CORS_ORIGINS=http://127.0.0.1:5173,http://localhost:5173 \
yarn start:dev
```

The runtime targets Node 24. `yarn start` and `yarn start:dev` use the Hub Nest CLI project, with watch mode for `start:dev`. `yarn start:prod` runs `dist/main.js`, and `yarn indexer:run` runs `dist/indexer/main.js`. Each startup command loads `.env` when it exists. For local browser integration, point the SDK at the Hub origin through `VITE_HUB` and optionally enable recipient discovery with `LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED=true`.

You can also copy `.env.example` to `.env` for the local runtime.

## Required configuration (minimum)

Set these env vars for local runtime:

- `DATABASE_URL`
- `OWNABLES_STORAGE` (optional; defaults to `file://storage`, set to override)
- `CORS_ORIGINS` (optional; comma-separated browser origins allowed to call Hub. Outside production the default allowlist is `http://127.0.0.1:5173,http://localhost:5173` for local SDK smoke; production defaults to no allowed origins until explicitly configured.)

Additional runtime configuration (feature-dependent):

- `SIGNER_PRIVATE_KEY` or `SIGNER_MNEMONIC`
- `HUB_NETWORK_PROFILE` (`testnet` default, or `mainnet`)
- `TESTNET_*_RPC_URL` / `MAINNET_*_RPC_URL` overrides
- `SIWE_DOMAIN`
- `PUBLIC_BASE_URL` for absolute package and chain URLs in Hub responses
- `LOCAL_DEV_RECIPIENT_DISCOVERY_ENABLED=true` to expose `GET /accounts/:account/available-ownables` outside production for localhost receive/import testing

## Tests

```bash
yarn test
yarn test:cov
```

Useful verification commands:

```bash
yarn typecheck
yarn lint:check
yarn test:e2e
```

`yarn test:e2e` builds both Nest bundles and runs the native compiled-process tests. It covers core package compatibility, the generated OpenAPI route inventory, `/info`, `/health`, canonical uploads, and rejected unsupported-runtime uploads without storage writes.

## Releasing

Releases are created by GitHub Actions using semantic-release.

- See [RELEASING.md](./RELEASING.md) for the release flow and commit conventions.
