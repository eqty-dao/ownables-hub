import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';
import { Readable } from 'node:stream';
import { decode, encode } from 'cbor-x';
import { OwnableService } from '../dist/ownable/ownable.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function packPtrLen(ptr, len) {
  return (BigInt(len >>> 0) << 32n) | BigInt(ptr >>> 0);
}

function buildAbiExports(owner) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let heapTop = 4096;
  let stateDump = [];
  const calls = {
    instantiate: 0,
    register: 0,
    query: 0,
    wasmByteLength: 0,
  };

  const alloc = (len) => {
    const ptr = heapTop;
    heapTop += Math.max(len, 1);
    return ptr;
  };
  const readInput = (ptr, len) => new Uint8Array(memory.buffer, ptr, len).slice();
  const writeOutput = (bytes) => {
    const ptr = alloc(bytes.length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return packPtrLen(ptr, bytes.length);
  };
  const makeEnvelope = (payload) =>
    writeOutput(
      encode({
        success: true,
        payload: encode(payload),
      }),
    );
  const makeResponse = (attributes, nextState = stateDump) =>
    makeEnvelope({
      result: encode({ attributes }),
      mem: { state_dump: nextState },
    });

  return {
    calls,
    exports: {
      memory,
      ownable_alloc: alloc,
      ownable_free: () => {},
      ownable_instantiate: (ptr, len) => {
        calls.instantiate += 1;
        const request = decode(readInput(ptr, len));
        stateDump = [[[1], [2]]];
        return makeResponse(
          [
            { key: 'method', value: 'instantiate' },
            { key: 'sender', value: request.info.sender },
          ],
          stateDump,
        );
      },
      ownable_execute: (_ptr, _len) => makeResponse([{ key: 'method', value: 'execute' }], stateDump),
      ownable_register: (ptr, len) => {
        calls.register += 1;
        const request = decode(readInput(ptr, len));
        stateDump = [...request.mem.state_dump, [[3], [4]]];
        return makeResponse(
          [
            { key: 'method', value: 'register' },
            { key: 'source', value: request.msg.source },
          ],
          stateDump,
        );
      },
      ownable_ingest: (_ptr, _len) => makeResponse([{ key: 'method', value: 'ingest' }], stateDump),
      ownable_query: (_ptr, _len) => {
        calls.query += 1;
        return makeEnvelope({
          result: Uint8Array.from(Buffer.from(JSON.stringify({ owner }), 'utf8')),
        });
      },
      ownable_encode_public_event: (ptr, len) => {
        const request = decode(readInput(ptr, len));
        return writeOutput(
          encode({
            success: true,
            payload: Uint8Array.from([request.eventType.length, request.data.length]),
          }),
        );
      },
    },
  };
}

function installAbiInstantiationShim(owner) {
  const originalInstantiate = WebAssembly.instantiate;
  const abi = buildAbiExports(owner);
  WebAssembly.instantiate = async (wasmBytes, imports) => {
    assert.deepEqual(imports ?? {}, {}, 'NodeSandboxOwnableRPC should instantiate the raw ABI runtime with no imports');
    abi.calls.wasmByteLength = wasmBytes.byteLength;
    return { exports: abi.exports };
  };
  return {
    calls: abi.calls,
    restore: () => {
      WebAssembly.instantiate = originalInstantiate;
    },
  };
}

async function toBuffer(stream) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

async function buildChain(wallet) {
  const chain = EventChain.create(wallet.address, 84532);
  const event = new Event({
    '@context': 'instantiate_msg.json',
    nft: {
      network: 'eip155:base',
      address: '0xabc0000000000000000000000000000000000001',
      id: '1',
    },
  });

  await event.addTo(chain).signWith({
    getAddress: async () => wallet.address,
    signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
  });

  return chain;
}

async function buildPackageZip() {
  const fixtureDir = join(__dirname, '..', 'src', 'cosmwasm', '_test');
  const ownableJs = await readFile(join(fixtureDir, 'ownable.js'));
  const ownableWasm = await readFile(join(fixtureDir, 'ownable_bg.wasm'));

  const zip = new JSZip();
  zip.file('package.json', JSON.stringify({ name: 'fixture-ownable' }));
  zip.file('ownable.js', ownableJs);
  zip.file('ownable_bg.wasm', ownableWasm);
  return {
    archive: await zip.generateAsync({ type: 'nodebuffer' }),
    wasmByteLength: ownableWasm.byteLength,
  };
}

async function buildUploadArchive(packageArchive, chainBuffer) {
  const zip = await new JSZip().loadAsync(packageArchive, { createFolders: true });
  zip.file('chain.json', chainBuffer);
  return zip.generateAsync({ type: 'uint8array' });
}

async function main() {
  const wallet = ethers.Wallet.createRandom();
  const expectedOwner = wallet.address.toLowerCase();
  const chain = await buildChain(wallet);

  const chainBuffer = Buffer.from(JSON.stringify(chain.toJSON()), 'utf8');
  const packageFixture = await buildPackageZip();
  const uploadArchive = await buildUploadArchive(packageFixture.archive, chainBuffer);

  const config = {
    getRuntimeNetworkProfile: () => 'testnet',
    getAuthoritySignerMnemonic: () => wallet.mnemonic?.phrase ?? '',
  };

  const nft = {
    getOwnerOfNFT: async () => wallet.address,
    isNFTlocked: async () => true,
    getUnlockProof: async () => 'unlock-proof',
    isUnlockProofValid: async () => true,
    getNFTcount: async () => '1',
    GetServerETHBalance: async () => '0',
  };

  const storedArtifacts = {
    eventChain: chainBuffer,
    packageZip: packageFixture.archive,
  };
  const storage = {
    storePackageArtifacts: async (_cid, zipData) => {
      storedArtifacts.packageZip = Buffer.from(zipData);
    },
    storeEventChain: async (_cid, eventChainData) => {
      storedArtifacts.eventChain = Buffer.from(eventChainData);
    },
    hasEventChain: async () => true,
    hasPackage: async () => true,
    getEventChain: async () => storedArtifacts.eventChain,
    getPackageZip: async () => storedArtifacts.packageZip,
  };

  const ownerStateCalls = [];
  const ownerStateByCid = new Map();
  const hubState = {
    upsertOwnableRecord: async () => ({ id: 'ownable-1', cid: 'cid-1', prevOwnerAddress: expectedOwner }),
    getOwnableByCid: async () => ({ id: 'ownable-1', cid: 'cid-1' }),
    listWalletEventsByCid: async () => [
      {
        id: 'evt-1',
        eventKind: 'public',
        slotName: 'testnet',
        chainId: '84532',
        anchorContractAddress: '0x1',
        blockNumber: '10',
        blockHash: '0x1',
        transactionHash: '0xaaa',
        transactionIndex: 0,
        logIndex: 1,
        eventName: 'PublicEvent',
        cid: 'cid-1',
        ownableId: 'ownable-1',
        ownerAddress: null,
        subjectId: chain.id,
        sourceAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'transfer',
        dataHex: '0x12345678abcdef',
        eventTimestamp: '1',
        payloadJson: {},
        indexedAt: new Date().toISOString(),
      },
    ],
    setOwnerState: async (id, owner, latestAppliedPublicEventId) => {
      ownerStateCalls.push({ id, owner, latestAppliedPublicEventId });
      ownerStateByCid.set('cid-1', {
        owner,
        version: ownerStateCalls.length,
        latestAppliedPublicEventId: latestAppliedPublicEventId ?? null,
      });
    },
    getOwnerStateByCid: async (cid) => ownerStateByCid.get(cid) ?? null,
  };
  const notifyService = {
    notifyOwnableAvailability: async () => undefined,
  };

  const wasmShim = installAbiInstantiationShim(expectedOwner);
  try {
    const service = new OwnableService(config, nft, storage, hubState, notifyService);
    await service.onModuleInit();

    const uploadResult = await service.uploadOwnable(uploadArchive, undefined, false);
    assert.equal(uploadResult.owner, expectedOwner, 'Expected upload replay to derive current owner');
    assert.equal(ownerStateCalls.length, 1, 'Expected upload to persist owner state before download');
    assert.equal(ownerStateCalls[0].id, 'ownable-1');
    assert.equal(ownerStateCalls[0].owner, expectedOwner);
    assert.equal(ownerStateCalls[0].latestAppliedPublicEventId, 'evt-1');

    const file = await service.downloadOwnable('cid-1');
    const buffer = await toBuffer(file.getStream());
    const outputZip = await new JSZip().loadAsync(buffer);

    assert.ok(outputZip.file('chain.json'), 'Expected chain.json in archive');
    assert.equal(outputZip.file('eventChain.json'), null, 'eventChain.json should not be emitted in archive');
    assert.equal(outputZip.file('authority_claim_msg.json'), null, 'authority_claim_msg.json should not be synthesized');
    assert.equal(ownerStateCalls.length, 2, 'Expected download replay to persist owner state after upload');
    assert.equal(wasmShim.calls.instantiate, 2, 'Expected replay runtime to instantiate for upload and download checks');
    assert.equal(wasmShim.calls.register, 2, 'Expected real core replay to register one public event per replay pass');
    assert.equal(wasmShim.calls.query, 2, 'Expected real core replay to query owner state per replay pass');
    assert.equal(wasmShim.calls.wasmByteLength, packageFixture.wasmByteLength);

    console.log(
      JSON.stringify({
        ownerState: ownerStateCalls[0],
        ownerStateCallCount: ownerStateCalls.length,
        uploadResult,
        archivedEntries: Object.keys(outputZip.files).sort(),
        rpcCalls: wasmShim.calls,
      }),
    );
  } finally {
    wasmShim.restore();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
