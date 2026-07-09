import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'cbor-x';
import JSZip from 'jszip';
import { ethers } from 'ethers';
import { Event, EventChain } from 'eqty-core';
import { EventChainService as CoreEventChainService, OwnableService as CoreOwnableService } from '@ownables/core';
import { NodePackageAssetIO, NodeSandboxOwnableRPC } from '@ownables/platform-node';
import { OwnableService } from '../dist/ownable/ownable.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNER_ADDRESS = '0x1111111111111111111111111111111111111111';
const OWNABLE_RECORD_ID = '00000000-0000-0000-0000-000000000111';
const PACKAGE_CID = 'cid-proof-block-stack';

function deriveSubjectId(ownableId) {
  return ethers.keccak256(ethers.getBytes(ownableId)).toLowerCase();
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
  const pkgDir = join(__dirname, '..', '..', 'ownables-sdk', 'ownables', 'block-stack', 'pkg');
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
        const store = storeOrData;
        const mapOrObj = mapMaybe;
        if (!mapOrObj) return;
        if (!this.stores.has(store)) this.stores.set(store, new Map());
        const storeMap = this.stores.get(store);
        if (mapOrObj instanceof Map) {
          for (const [k, v] of mapOrObj.entries()) storeMap.set(k, v);
        } else {
          for (const [k, v] of Object.entries(mapOrObj)) storeMap.set(k, v);
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
      throw new Error('emitPublicEvent is not used in replay proof');
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

async function buildIndexedPublicRow(packageCid, packageZipBuffer, eventChainBuffer, subjectId) {
  const { chain, coreOwnables } = await buildCoreReplayHarness(packageCid, packageZipBuffer, eventChainBuffer);
  const encoded = await coreOwnables.rpc(chain.id).encodePublicEvent(
    'stack',
    encode({ total_blocks: 2 }),
  );
  coreOwnables.clearRpc(chain.id);

  return {
    id: 'evt-stack-1',
    slotName: 'testnet',
    chainId: '84532',
    anchorContractAddress: '0x00000000000000000000000000000000000000aa',
    blockNumber: '11',
    blockHash: `0x${'de'.repeat(32)}`,
    transactionHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: 3,
    eventName: 'PublicEvent',
    cid: packageCid,
    ownableId: OWNABLE_RECORD_ID,
    ownerAddress: null,
    subjectId,
    sourceAddress: SIGNER_ADDRESS.toLowerCase(),
    eventType: 'stack',
    dataHex: ethers.hexlify(encoded),
    eventTimestamp: '42',
    payloadJson: { total_blocks: 2 },
    indexedAt: new Date().toISOString(),
  };
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

function createHubService(chain, chainBuffer, packageZipBuffer, indexedPublicRows) {
  const subjectId = deriveSubjectId(chain.id);
  const [anchor] = chain.anchorMap;
  assert.ok(anchor, 'Expected replay proof chain to produce an anchor pair');

  const publicReplaySubjectCalls = [];
  const storageCalls = [];

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
        throw new Error('Hub replay proof must not resolve live NFT ownership');
      },
      isNFTlocked: async () => true,
      getUnlockProof: async () => 'unlock-proof',
      isUnlockProofValid: async () => true,
      getNFTcount: async () => '1',
      GetServerETHBalance: async () => '0',
    },
    {
      storePackageArtifacts: async () => {
        throw new Error('Hub replay proof must not persist replay outputs');
      },
      storeEventChain: async () => {
        throw new Error('Hub replay proof must not append synthetic private follow-up events');
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
    },
    {
      upsertOwnableRecord: async () => {
        throw new Error('Hub replay proof must not write ownable records');
      },
      setOwnerState: async () => {
        throw new Error('Hub replay proof must not persist replay-derived owner state');
      },
      getOwnableByNft: async () => null,
      getOwnableBySubjectId: async (receivedSubjectId) => ({
        id: OWNABLE_RECORD_ID,
        packageCid: PACKAGE_CID,
        prevOwnerAddress: SIGNER_ADDRESS.toLowerCase(),
        subjectId: receivedSubjectId,
        nftNetwork: 'eip155:base',
        nftContractAddress: '0xabc0000000000000000000000000000000000001',
        nftTokenId: '1',
      }),
      listOwnableCidsByPrevOwner: async () => [],
      listAvailableOwnablesByOwnerAccount: async () => [],
      listIndexedAnchorEventsByPackageCid: async () => [
        {
          transactionHash: '0xaaa',
          blockNumber: '10',
          transactionIndex: 0,
          logIndex: 0,
          ownerAddress: SIGNER_ADDRESS.toLowerCase(),
          payloadJson: { key: anchor.key.hex, value: anchor.value.hex },
        },
      ],
      listIndexedPublicEventsBySubjectId: async (receivedSubjectId) => {
        publicReplaySubjectCalls.push(receivedSubjectId);
        return indexedPublicRows.map((row) => ({ ...row, subjectId: receivedSubjectId }));
      },
    },
  );

  return { service, subjectId, publicReplaySubjectCalls, storageCalls };
}

async function main() {
  const chain = await buildStoredChain();
  const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
  const packageZipBuffer = await buildStoredPackageZip();
  const subjectId = deriveSubjectId(chain.id);
  const indexedPublicRow = await buildIndexedPublicRow(PACKAGE_CID, packageZipBuffer, chainBuffer, subjectId);

  const withEvent = createHubService(chain, chainBuffer, packageZipBuffer, [indexedPublicRow]);
  const withoutEvent = createHubService(chain, chainBuffer, packageZipBuffer, []);

  const verification = await withEvent.service.getOwnableVerification(chain.id);
  const widgetStateWithEvent = await queryWidgetState(PACKAGE_CID, packageZipBuffer, chainBuffer, [indexedPublicRow]);
  const widgetStateWithoutEvent = await queryWidgetState(PACKAGE_CID, packageZipBuffer, chainBuffer, []);

  assert.equal(verification.verified, true);
  assert.equal(verification.ownableId, chain.id);
  assert.equal(verification.packageCid, PACKAGE_CID);
  assert.equal(verification.owner, SIGNER_ADDRESS.toLowerCase());
  assert.equal(verification.ownerAccount, `eip155:84532:${SIGNER_ADDRESS.toLowerCase()}`);
  assert.equal(verification.freshness.stale, false);
  assert.deepEqual(withEvent.publicReplaySubjectCalls, [subjectId]);
  assert.equal(widgetStateWithEvent.replay.appliedReplayKeys.length, 1);
  assert.deepEqual(widgetStateWithEvent.replay.appliedReplayKeys, [`0x${'bb'.repeat(32)}:3`]);
  assert.equal(widgetStateWithEvent.widgetState.stacked_blocks, 2);
  assert.equal(widgetStateWithoutEvent.replay.appliedReplayKeys.length, 0);
  assert.equal(widgetStateWithoutEvent.widgetState.stacked_blocks, 1);
  assert.ok(
    withEvent.storageCalls.every(([name]) => !['storeEventChain', 'storePackageArtifacts'].includes(name)),
    'Replay proof must not use synthetic private writes',
  );

  console.log(
    JSON.stringify({
      verifiedBoundary: 'hub-replay-only-registration',
      ownableId: chain.id,
      subjectId,
      stackedBlocksWithoutIndexedEvent: widgetStateWithoutEvent.widgetState.stacked_blocks,
      stackedBlocksWithIndexedEvent: widgetStateWithEvent.widgetState.stacked_blocks,
      replayKeysWithIndexedEvent: widgetStateWithEvent.replay.appliedReplayKeys,
      verificationOwner: verification.owner,
      storageCalls: withEvent.storageCalls,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
