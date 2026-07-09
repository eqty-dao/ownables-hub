import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'cbor-x';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';
import JSZip from 'jszip';
import { Client } from 'pg';
import { EventChainService as CoreEventChainService, OwnableService as CoreOwnableService } from '@ownables/core';
import { NodePackageAssetIO, NodeSandboxOwnableRPC } from '@ownables/platform-node';
import { OwnableService } from '../dist/ownable/ownable.service.js';
import { HubStateRepository } from '../dist/persistence/repos/hub-state.repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const migrationsDir = join(repoRoot, 'migrations');
const migrateBin = join(repoRoot, 'node_modules/node-pg-migrate/bin/node-pg-migrate');
const pkgDir = join(repoRoot, '..', 'ownables-sdk', 'ownables', 'block-stack', 'pkg');
const databaseUrl = process.env.DATABASE_URL;
const SIGNER_ADDRESS = '0x1111111111111111111111111111111111111111';
const PACKAGE_CID = 'cid-proof-block-stack';

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for verify-postgres-replay-proof');
}

function deriveSubjectId(ownableId) {
  return ethers.keccak256(ethers.getBytes(ownableId)).toLowerCase();
}

function runMigrationsForSchema(schema) {
  execFileSync(
    process.execPath,
    [
      migrateBin,
      'up',
      '--migrations-dir',
      migrationsDir,
      '--schema',
      schema,
      '--create-schema',
      '--migrations-schema',
      schema,
      '--create-migrations-schema',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );
}

async function withSchema(run) {
  const schema = `hub_replay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  runMigrationsForSchema(schema);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO "${schema}", public`);

  const repo = new HubStateRepository({
    query: (text, values = []) => client.query(text, values),
    withClient: async (fn) => fn(client),
  });

  try {
    return await run(repo, client);
  } finally {
    await client.end();

    const cleanupClient = new Client({ connectionString: databaseUrl });
    await cleanupClient.connect();
    try {
      await cleanupClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanupClient.end();
    }
  }
}

async function buildStoredChain() {
  const chain = EventChain.create(SIGNER_ADDRESS, 84532);
  const signer = {
    getAddress: async () => SIGNER_ADDRESS,
    signTypedData: async () => `0x${'00'.repeat(65)}`,
  };
  const event = new Event({
    '@context': 'instantiate_msg.json',
    ownable_id: chain.id,
    package: PACKAGE_CID,
    network_id: 84532,
    nft: {
      network: 'eip155:base',
      address: '0xabc0000000000000000000000000000000000001',
      id: '1',
    },
    anchors: [{ key: { hex: '0xanchor' }, value: { hex: '0xbbb' } }],
  });

  await event.addTo(chain).signWith(signer);
  return chain;
}

async function buildStoredPackageZip() {
  const [runtimeWasm, packageJson] = await Promise.all([
    readFile(join(pkgDir, 'ownable_bg.wasm')),
    readFile(join(pkgDir, 'package.json'), 'utf8'),
  ]);

  const zipped = new JSZip();
  zipped.file('package.json', packageJson);
  zipped.file('ownable_bg.wasm', runtimeWasm);
  return zipped.generateAsync({ type: 'nodebuffer' });
}

async function loadPackageFiles(packageZipBuffer, eventChainBuffer) {
  const zipped = new JSZip();
  await zipped.loadAsync(packageZipBuffer, { createFolders: true });
  zipped.file('chain.json', eventChainBuffer);
  const generated = await zipped.generateAsync({ type: 'uint8array' });
  const hydrated = new JSZip();
  await hydrated.loadAsync(generated, { createFolders: true });

  const files = new Map();
  for (const file of Object.values(hydrated.files)) {
    if (!file.dir) {
      files.set(file.name, Buffer.from(await file.async('uint8array')));
    }
  }
  return files;
}

async function buildCoreReplayHarness(packageCid, packageZipBuffer, eventChainBuffer) {
  const chain = EventChain.from(JSON.parse(eventChainBuffer.toString('utf8')));
  const files = await loadPackageFiles(packageZipBuffer, eventChainBuffer);
  const stateStore = new (class {
    stores = new Map();
    async get(store, key) {
      return this.stores.get(store)?.get(key);
    }
    async getAll(store) {
      return Array.from(this.stores.get(store)?.values() ?? []);
    }
    async getMap(store) {
      return new Map(this.stores.get(store) ?? []);
    }
    async keys(store) {
      return Array.from(this.stores.get(store)?.keys() ?? []);
    }
    async set(store, key, value) {
      if (!this.stores.has(store)) this.stores.set(store, new Map());
      this.stores.get(store)?.set(key, value);
    }
    async setAll(storeOrData, mapMaybe) {
      if (typeof storeOrData === 'string') {
        if (!mapMaybe) return;
        if (!this.stores.has(storeOrData)) this.stores.set(storeOrData, new Map());
        const storeMap = this.stores.get(storeOrData);
        if (mapMaybe instanceof Map) {
          for (const [k, v] of mapMaybe.entries()) storeMap.set(k, v);
        } else {
          for (const [k, v] of Object.entries(mapMaybe)) storeMap.set(k, v);
        }
        return;
      }
      for (const [store, mapOrObj] of Object.entries(storeOrData)) {
        if (!this.stores.has(store)) this.stores.set(store, new Map());
        const storeMap = this.stores.get(store);
        if (mapOrObj instanceof Map) {
          for (const [k, v] of mapOrObj.entries()) storeMap.set(k, v);
        } else {
          for (const [k, v] of Object.entries(mapOrObj)) storeMap.set(k, v);
        }
      }
    }
    async hasStore(store) {
      return this.stores.has(store);
    }
    async createStore(...stores) {
      for (const store of stores) if (!this.stores.has(store)) this.stores.set(store, new Map());
    }
    async deleteStore(store) {
      this.stores.delete(store);
    }
    async listStores() {
      return Array.from(this.stores.keys());
    }
    async delete(store, key) {
      this.stores.get(store)?.delete(key);
    }
  })();

  const anchorProvider = {
    address: '0x0000000000000000000000000000000000000000',
    chainId: 0,
    signer: null,
    sign: async () => {},
    anchor: async () => {},
    submitAnchors: async () => undefined,
    emitPublicEvent: async () => {
      throw new Error('emitPublicEvent is not used in postgres replay proof');
    },
    verifyAnchors: async (...anchors) => ({
      verified: anchors.length > 0,
      anchors: Object.fromEntries(anchors.map(({ key }) => [key.hex, '0xaaa'])),
      map: Object.fromEntries(anchors.map(({ key, value }) => [key.hex, value.hex.toLowerCase()])),
      details: Object.fromEntries(
        anchors.map(({ key, value }) => [
          key.hex,
          {
            key: key.hex,
            expectedValue: value.hex.toLowerCase(),
            value: value.hex.toLowerCase(),
            verified: true,
            source: 'indexed',
            transactionHash: '0xaaa',
            blockNumber: 10,
            transactionIndex: 0,
            logIndex: 0,
          },
        ]),
      ),
    }),
  };

  const packageInfo = {
    title: packageCid,
    name: packageCid,
    cid: packageCid,
    isDynamic: true,
    hasMetadata: false,
    hasWidgetState: true,
    hasAttachments: false,
    isClosable: false,
    isConsumable: false,
    isConsumer: false,
    isLockable: false,
    isTransferable: false,
    versions: [{ date: new Date(), cid: packageCid }],
  };

  const packageAssetIO = new NodePackageAssetIO({
    infoResolver: () => packageInfo,
    assetLoader: async (_packageCid, name) => files.get(name),
    assetList: async () => Array.from(files.keys()),
  });

  const eventChains = new CoreEventChainService(stateStore, anchorProvider);
  const coreOwnables = new CoreOwnableService(
    stateStore,
    eventChains,
    anchorProvider,
    packageAssetIO,
    undefined,
    console,
    { create: (id) => new NodeSandboxOwnableRPC(id) },
  );

  await coreOwnables.initWorker(chain.id, packageCid);
  const privateStateDump = await coreOwnables.apply(chain, []);
  return { chain, coreOwnables, privateStateDump };
}

async function encodeIndexedPublicEventData(packageCid, packageZipBuffer, eventChainBuffer, eventType, payload) {
  const { chain, coreOwnables } = await buildCoreReplayHarness(packageCid, packageZipBuffer, eventChainBuffer);
  const encoded = await coreOwnables.rpc(chain.id).encodePublicEvent(eventType, encode(payload));
  coreOwnables.clearRpc(chain.id);
  return ethers.hexlify(encoded);
}

async function queryWidgetState(packageCid, packageZipBuffer, eventChainBuffer, indexedPublicRows) {
  const { chain, coreOwnables, privateStateDump } = await buildCoreReplayHarness(packageCid, packageZipBuffer, eventChainBuffer);
  const replay = await coreOwnables.attemptReplayIndexedPublicEvents(
    chain.id,
    privateStateDump,
    indexedPublicRows.map((row) => ({
      source: row.sourceAddress,
      eventType: row.eventType,
      data: row.dataHex,
      blockNumber: Number(row.blockNumber),
      transactionHash: row.transactionHash,
      transactionIndex: row.transactionIndex,
      logIndex: row.logIndex,
      timestamp: Number(row.eventTimestamp),
    })),
  );
  const widgetState = await coreOwnables.rpc(chain.id).query({ get_widget_state: {} }, replay.stateDump);
  coreOwnables.clearRpc(chain.id);
  return { replay, widgetState };
}

async function main() {
  await withSchema(async (repo) => {
    const chain = await buildStoredChain();
    const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
    const packageZipBuffer = await buildStoredPackageZip();
    const subjectId = deriveSubjectId(chain.id);
    const [anchor] = chain.anchorMap;
    assert.ok(anchor, 'Expected stored chain to contain an anchor pair');

    const record = await repo.upsertOwnableRecord({
      packageCid: PACKAGE_CID,
      prevOwnerAddress: SIGNER_ADDRESS,
      subjectId,
      nftNetwork: 'eip155:base',
      nftContractAddress: '0xabc0000000000000000000000000000000000001',
      nftTokenId: '1',
    });

      await repo.upsertIndexedAnchorEvent({
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x00000000000000000000000000000000000000aa',
        blockNumber: 10n,
        blockHash: `0x${'aa'.repeat(32)}`,
        transactionHash: `0x${'ab'.repeat(32)}`,
        transactionIndex: 0,
        logIndex: 0,
      eventName: 'Anchored',
      cid: PACKAGE_CID,
      ownableId: record.id,
      ownerAddress: SIGNER_ADDRESS.toLowerCase(),
      payloadJson: { key: anchor.key.hex, value: anchor.value.hex },
    });

    const stackToThreeDataHex = await encodeIndexedPublicEventData(
      PACKAGE_CID,
      packageZipBuffer,
      chainBuffer,
      'stack',
      { total_blocks: 3 },
    );
    const stackToTwoDataHex = await encodeIndexedPublicEventData(
      PACKAGE_CID,
      packageZipBuffer,
      chainBuffer,
      'stack',
      { total_blocks: 2 },
    );

    await repo.upsertIndexedPublicEvent({
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0x00000000000000000000000000000000000000aa',
      blockNumber: 12n,
      blockHash: `0x${'cd'.repeat(32)}`,
      transactionHash: `0x${'cc'.repeat(32)}`,
      transactionIndex: 0,
      logIndex: 0,
      eventName: 'PublicEvent',
      subjectId,
      sourceAddress: SIGNER_ADDRESS,
      eventType: 'stack',
      dataHex: stackToThreeDataHex,
      eventTimestamp: 43n,
      payloadJson: { total_blocks: 3 },
    });
    await repo.upsertIndexedPublicEvent({
      slotName: 'testnet',
      chainId: '84532',
      anchorContractAddress: '0x00000000000000000000000000000000000000aa',
      blockNumber: 11n,
      blockHash: `0x${'bc'.repeat(32)}`,
      transactionHash: `0x${'bb'.repeat(32)}`,
      transactionIndex: 0,
      logIndex: 0,
      eventName: 'PublicEvent',
      subjectId,
      sourceAddress: SIGNER_ADDRESS,
      eventType: 'stack',
      dataHex: stackToTwoDataHex,
      eventTimestamp: 42n,
      payloadJson: { total_blocks: 2 },
    });

    const persistedRows = await repo.listIndexedPublicEventsBySubjectId(subjectId);
    assert.deepEqual(
      persistedRows.map((row) => row.transactionHash),
      [`0x${'bb'.repeat(32)}`, `0x${'cc'.repeat(32)}`],
    );
    assert.deepEqual(
      persistedRows.map((row) => row.ownableId),
      [record.id, record.id],
    );
    assert.deepEqual(
      persistedRows.map((row) => row.cid),
      [PACKAGE_CID, PACKAGE_CID],
    );

    const storageCalls = [];
    const storage = {
      storePackageArtifacts: async (...args) => {
        storageCalls.push(['storePackageArtifacts', args]);
      },
      storeEventChain: async (...args) => {
        storageCalls.push(['storeEventChain', args]);
      },
      hasEventChain: async (recordId, packageCid) => {
        storageCalls.push(['hasEventChain', recordId, packageCid]);
        return true;
      },
      hasPackage: async (packageCid) => {
        storageCalls.push(['hasPackage', packageCid]);
        return true;
      },
      getEventChain: async (recordId, packageCid) => {
        storageCalls.push(['getEventChain', recordId, packageCid]);
        return chainBuffer;
      },
      getPackageZip: async (packageCid) => {
        storageCalls.push(['getPackageZip', packageCid]);
        return packageZipBuffer;
      },
    };

    const service = new OwnableService(
      {
        getRuntimeNetworkProfile: () => 'testnet',
        getAuthoritySignerMnemonic: () =>
          ethers.Wallet.createRandom().mnemonic?.phrase ?? 'test test test test test test test test test test test junk',
        getAppConfig: () => ({ publicBaseUrl: 'http://127.0.0.1:8000' }),
        isLocalDevRecipientDiscoveryEnabled: () => true,
      },
      {
        getOwnerOfNFT: async () => {
          throw new Error('postgres replay proof must not resolve live nft ownership');
        },
        isNFTlocked: async () => true,
        getUnlockProof: async () => 'unlock-proof',
        isUnlockProofValid: async () => true,
        getNFTcount: async () => '1',
        GetServerETHBalance: async () => '0',
      },
      storage,
      repo,
    );

    const verification = await service.getOwnableVerification(chain.id);
    const widgetState = await queryWidgetState(PACKAGE_CID, packageZipBuffer, chainBuffer, persistedRows);

    assert.equal(verification.verified, true);
    assert.equal(verification.ownableId, chain.id);
    assert.equal(verification.packageCid, PACKAGE_CID);
    assert.equal(verification.owner, SIGNER_ADDRESS.toLowerCase());
    assert.equal(verification.ownerAccount, `eip155:84532:${SIGNER_ADDRESS.toLowerCase()}`);
    assert.equal(widgetState.widgetState.stacked_blocks, 3);
    assert.deepEqual(widgetState.replay.appliedReplayKeys, [`0x${'bb'.repeat(32)}:0`, `0x${'cc'.repeat(32)}:0`]);
    assert.deepEqual(widgetState.replay.ignoredPublicEvents, []);
    assert.ok(
      storageCalls.every(([name]) => !['storeEventChain', 'storePackageArtifacts'].includes(name)),
      'Postgres replay proof must not use synthetic private writes',
    );

    console.log(
      JSON.stringify({
        verifiedBoundary: 'postgres-subjectid-replay-proof',
        ownableId: chain.id,
        subjectId,
        publicTransactionHashes: persistedRows.map((row) => row.transactionHash),
        stackedBlocks: widgetState.widgetState.stacked_blocks,
        replayKeys: widgetState.replay.appliedReplayKeys,
        storageCalls,
      }),
    );
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
