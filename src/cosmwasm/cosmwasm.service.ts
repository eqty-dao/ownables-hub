import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as vm from 'vm';
import Contract from './contract';
import * as babel from '@babel/core';
import { TextEncoder, TextDecoder } from 'util';
import pathToFileURL from 'url';

@Injectable()
export class CosmWasmService {
  private async loadModule(moduleFile: string): Promise<string> {
    const { code } = await babel.transformFileAsync(moduleFile, {
      plugins: [
        'babel-plugin-remove-import-export',
        __dirname + '/babel/transfer-import-meta',
      ],
    });

    return code;
  }

  async load(moduleFile: string, wasmFile: string): Promise<Contract> {
    const code = await this.loadModule(moduleFile);
    const wasmBuffer = await fs.readFile(wasmFile);

    const sandbox = vm.createContext({
      TextEncoder,
      TextDecoder,
      pathToFileURL,
    });

    vm.runInContext(code, sandbox);

    const contract: Contract = new Contract(sandbox);
    await contract.init(wasmBuffer);

    return contract;
  }
}
