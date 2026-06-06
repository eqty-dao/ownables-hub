![Ownables Hub](https://user-images.githubusercontent.com/100821/196711741-96cd4ba5-932a-4e95-b420-42d4d61c21fd.png)

# Ownables Hub

Hub service for Ownables and lockable NFTs on EVM networks (Base-focused).

The hub stores an Ownable copy and acts as unlock-signing authority for lockable NFTs.
It only issues unlock proofs when it has the corresponding Ownable copy.

## What this service does

- Accepts and stores bridged Ownables (zip packages + event chain data)
- Maps Ownables to NFT metadata
- Validates lock state and signs unlock challenges via the hub wallet
- Serves claim/download flow for stored Ownables
- Exposes operational endpoints for chain, CID, proof, and server info

## Installation

```bash
yarn install
```

Built with [NestJS](https://nestjs.com/).

## Authentication (SIWE)

Protected hub routes use SIWE-authenticated request context.

- `POST /api/v1/auth/nonce` returns nonce
- `POST /api/v1/auth/verify` verifies SIWE payload and returns bearer token
- Send `Authorization: Bearer <base64-json-token>` for protected endpoints

Config:

- `SIWE_DOMAIN=<expected-domain>` sets accepted SIWE domain

## Key API routes

Base path for hub routes: `/ownables`

- `POST /ownables/bridge` upload Ownable package
- `GET /ownables/proof?cid=...` get unlock proof for mapped NFT
- `GET /ownables/isUnlockProofValid?...` verify unlock proof
- `GET /ownables/claim?...` claim Ownable package
- `GET /ownables/cid?...` lookup CID by NFT
- `GET /ownables/chains` list available NFT chain setup
- `GET /ownables/serverinfo` inspect wallet balances and hub info
- `GET /notify/delivery-status?cid=<cid>&owner=<caip10-account>` inspect the latest public notify delivery status for one owner/account pair
- `GET /notify/local/discovery?owner=<caip10-account>` list local/dev-only failed notification availability entries for one owner/account when explicitly enabled

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
yarn start:dev
```

## Required configuration (minimum)

Set these env vars for local runtime:

- `DATABASE_URL`
- `OWNABLES_STORAGE` (optional; defaults to `file://storage`, set to override)

Additional runtime configuration (feature-dependent):

- `ACCOUNT_MNEMONIC`
- `HUB_NETWORK_PROFILE` (`testnet` default, or `mainnet`)
- `TESTNET_*_RPC_URL` / `MAINNET_*_RPC_URL` overrides
- `SIWE_DOMAIN`
- `PUBLIC_BASE_URL` for absolute download URLs in notifications
- `LOCAL_DEV_NOTIFICATION_DISCOVERY_ENABLED=true` to expose `GET /notify/local/discovery` outside production for localhost receive/import testing without Reown

Optional Reown notify publishing configuration:

- `REOWN_PROJECT_ID`
- `REOWN_NOTIFY_API_SECRET`
- `REOWN_NOTIFICATION_TYPE_ID`
- `REOWN_APP_DOMAIN`

Reown notify stays non-blocking:

- if the Reown env vars are unset or partially configured, upload/download still succeed and Hub records `failed_configuration`
- if the owner account is not subscribed to the configured notification type, upload/download still succeed and Hub records `not_subscribed`
- Hub no longer exposes a topic registration endpoint or stores local topic registrations

## Tests

```bash
yarn test
yarn test:cov
```

## Releasing

Releases are created by GitHub Actions using semantic-release.

- See [RELEASING.md](./RELEASING.md) for the release flow and commit conventions.
