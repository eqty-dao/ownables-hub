import * as vm from 'vm';

type Dict<T = any> = { [_: string]: T };
type CosmWasmEvent = { type: string; attributes: Array<{ key: string; value: any }> };

interface MsgInfo {
  sender: string;
  funds: [];
}

export default class Contract {
  constructor(private sandbox: vm.Context) {
    this.sandbox.mem = { state_dump: [] };
  }

  private run(call: string, context: { [_: string]: any }): any {
    for (const key in context) {
      this.sandbox[key] = context[key];
    }

    let result: any;

    try {
      vm.runInContext('result = ' + call, this.sandbox);
      result = this.sandbox.result;
    } finally {
      for (const key in context) {
        delete this.sandbox[key];
      }
      delete this.sandbox.result;
    }

    return result;
  }

  private static attributesToDict(attributes: Array<{ key: string; value: any }>): Dict {
    return Object.fromEntries(attributes.map(({ key, value }) => [key, value]));
  }

  private static eventAttributesToDict(events: CosmWasmEvent[]): Array<{ type: string; attributes: Dict }> {
    return events.map(({ type, attributes }) => ({
      type,
      attributes: Contract.attributesToDict(attributes),
    }));
  }

  async init(buffer: Buffer): Promise<void> {
    await this.run('init(buffer)', { buffer });
  }

  async instantiate(msg: Dict, info: MsgInfo): Promise<{ attributes: Dict }> {
    if (!('nft' in msg)) msg.nft = undefined;
    if (!('ownable_type' in msg)) msg.ownable_type = undefined;
    if (typeof msg.network_id === 'string') msg.network_id = msg.network_id.charCodeAt(0);

    const result: Map<string, any> = await this.run('instantiate_contract(msg, info)', { msg, info });

    const response = JSON.parse(result.has('state') ? result.get('state') : result.get('result'));
    this.sandbox.mem = JSON.parse(result.get('mem'));

    return {
      attributes: Contract.attributesToDict(response.attributes),
    };
  }

  async execute(
    msg: Dict,
    info: MsgInfo,
  ): Promise<{ attributes: Dict; events: Array<{ type: string; attributes: Dict }>; data?: any }> {
    const result: Map<string, any> = await this.run('execute_contract(msg, info, mem)', { msg, info });

    const response = JSON.parse(result.has('state') ? result.get('state') : result.get('result'));
    this.sandbox.mem = JSON.parse(result.get('mem'));

    return {
      attributes: Contract.attributesToDict(response.attributes),
      events: Contract.eventAttributesToDict(response.events || []),
      data: response.data,
    };
  }

  async externalEvent(
    msg: Dict,
    info: MsgInfo,
  ): Promise<{ attributes: Dict; events: Array<{ type: string; attributes: Dict }>; data?: any }> {
    const result: Map<string, any> = await this.run('register_external_event(msg, info, mem)', { msg, info });

    const response = JSON.parse(result.has('state') ? result.get('state') : result.get('result'));
    this.sandbox.mem = JSON.parse(result.get('mem'));

    return {
      attributes: Contract.attributesToDict(response.attributes),
      events: Contract.eventAttributesToDict(response.events || []),
      data: response.data,
    };
  }

  async queryRaw(msg: Dict): Promise<string> {
    const result = await this.run('query_contract_state(msg, mem)', { msg });
    return JSON.parse(result.has('state') ? result.get('state') : result.get('result'));
  }

  async query(msg: Dict): Promise<any> {
    const resultB64 = await this.queryRaw(msg);
    return JSON.parse(atob(resultB64));
  }
}
