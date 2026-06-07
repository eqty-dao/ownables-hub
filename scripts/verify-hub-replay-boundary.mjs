import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { Event, EventChain } from 'eqty-core';
import { ethers } from 'ethers';
import { OwnableController } from '../dist/ownable/ownable.controller.js';
import { OwnableService } from '../dist/ownable/ownable.service.js';
import { UserError } from '../dist/interfaces/error.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPECTED_ERROR_PREFIX = "Invalid package: unsupported Ownable runtime in 'ownable_bg.wasm'.";

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

async function buildUnsupportedUploadArchive() {
  const fixtureDir = join(__dirname, '..', 'src', 'cosmwasm', '_test');
  const [ownableJs, ownableWasm] = await Promise.all([
    readFile(join(fixtureDir, 'ownable.js')),
    readFile(join(fixtureDir, 'ownable_bg.wasm')),
  ]);

  const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(Uint8Array.from(ownableWasm))).map(
    ({ module, name }) => ({
      module,
      name,
    }),
  );

  const wallet = ethers.Wallet.createRandom();
  const chain = await buildChain(wallet);

  const zip = new JSZip();
  zip.file('package.json', JSON.stringify({ name: 'fixture-ownable' }));
  zip.file('ownable.js', ownableJs);
  zip.file('ownable_bg.wasm', ownableWasm);
  zip.file('chain.json', JSON.stringify(chain.toJSON()));

  return {
    archive: await zip.generateAsync({ type: 'uint8array' }),
    moduleImports,
  };
}

function buildService() {
  const storageCalls = [];
  const upsertCalls = [];

  const config = {
    getRuntimeNetworkProfile: () => 'testnet',
    getAuthoritySignerMnemonic: () => ethers.Wallet.createRandom().mnemonic?.phrase ?? '',
  };
  const nft = {
    getOwnerOfNFT: async () => {
      throw new Error('not reached');
    },
    isNFTlocked: async () => true,
    getUnlockProof: async () => 'unlock-proof',
    isUnlockProofValid: async () => true,
    getNFTcount: async () => '1',
    GetServerETHBalance: async () => '0',
  };
  const storage = {
    storePackageArtifacts: async (...args) => {
      storageCalls.push(['storePackageArtifacts', args]);
    },
    storeEventChain: async (...args) => {
      storageCalls.push(['storeEventChain', args]);
    },
    hasEventChain: async () => false,
    hasPackage: async () => false,
    getEventChain: async () => {
      throw new Error('not reached');
    },
    getPackageZip: async () => {
      throw new Error('not reached');
    },
  };
  const hubState = {
    upsertOwnableRecord: async (...args) => {
      upsertCalls.push(args);
      return { id: 'ownable-1', cid: 'cid-1', prevOwnerAddress: '0x0' };
    },
    setOwnerState: async () => undefined,
    getOwnerStateByCid: async () => null,
    getOwnableByCid: async () => null,
    getOwnableByNft: async () => null,
    listOwnableCidsByPrevOwner: async () => [],
    listWalletEventsByCid: async () => [],
  };
  const notifyService = {
    notifyOwnableAvailability: async () => undefined,
  };

  return {
    service: new OwnableService(config, nft, storage, hubState, notifyService),
    storageCalls,
    upsertCalls,
  };
}

function buildResponse() {
  const response = {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  return response;
}

async function main() {
  const { archive, moduleImports } = await buildUnsupportedUploadArchive();
  assert.ok(moduleImports.length > 0, 'Expected unsupported fixture to require wasm imports');

  const { service, storageCalls, upsertCalls } = buildService();

  let uploadError;
  try {
    await service.uploadOwnable(archive, undefined, false);
  } catch (error) {
    uploadError = error;
  }

  assert.ok(uploadError instanceof UserError, 'Expected unsupported runtime upload to raise UserError');
  assert.match(uploadError.message, new RegExp(`^${EXPECTED_ERROR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(storageCalls.length, 0, 'Invalid runtime uploads must be rejected before persistence');
  assert.equal(upsertCalls.length, 0, 'Invalid runtime uploads must not create ownable records');

  const controller = new OwnableController(service);
  const res = buildResponse();
  await controller.uploadOwnable({ file: { buffer: Buffer.from(archive) } }, res, undefined);

  assert.equal(res.statusCode, 400, 'Expected upload controller to return HTTP 400 for unsupported runtime');
  assert.equal(res.body, uploadError.message, 'Expected controller response to preserve deterministic runtime validation message');

  console.log(
    JSON.stringify({
      verifiedBoundary: 'unsupported-runtime-upload-classification',
      statusCode: res.statusCode,
      errorMessage: uploadError.message,
      importModules: Array.from(new Set(moduleImports.map(({ module }) => module))).sort(),
      importCount: moduleImports.length,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
