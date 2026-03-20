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
npm install
```

Built with [NestJS](https://nestjs.com/).

## Authentication (SIWE)

Protected hub routes use SIWE-authenticated request context.

- `POST /api/v1/auth/nonce` returns nonce
- `POST /api/v1/auth/verify` verifies SIWE payload and returns bearer token
- Send `Authorization: Bearer <base64-json-token>` for protected endpoints

Config:

- `AUTH_DISABLE=true` disables auth checks (development/testing only)
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

Swagger: `http://localhost:3000/api-docs`

## Local run

```bash
npm run start:dev
```

## Required configuration (minimum)

Set these env vars for a usable local/prod setup:

- `ACCOUNT_MNEMONIC`
- `BASE_ALCHEMY_API_KEY`
- `BASE_NFT_CONTRACT_ADDR` and/or `BASE_SEPOLIA_NFT_CONTRACT_ADDR`
- `SIWE_DOMAIN`

Additional keys are available in `src/config/schema.ts`.

## Tests

```bash
npm test
npm run test:cov
```

## Releasing

Releases are created by GitHub Actions using semantic-release.

- See [RELEASING.md](./RELEASING.md) for the release flow and commit conventions.
