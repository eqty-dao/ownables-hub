import { ethers } from 'ethers';

export class Binary {
  private readonly value: string;

  constructor(data: string | Uint8Array) {
    this.value = typeof data === 'string' ? data : ethers.hexlify(data);
  }

  static fromHex(hex: string): string {
    return hex;
  }

  get hex(): string {
    if (this.value.startsWith('0x')) {
      return this.value;
    }
    return `0x${Buffer.from(this.value).toString('hex')}`;
  }
}

export class Event {
  parsedData: any;
  signerAddress?: string;
  signature?: string;
  previous?: string;

  constructor(data: any) {
    this.parsedData = data;
  }

  addTo(chain: EventChain): this {
    chain.events.push(this);
    return this;
  }

  async signWith(signer: { getAddress: () => Promise<string>; signTypedData: (domain: any, types: any, value: any) => Promise<string> }): Promise<void> {
    this.signerAddress = await signer.getAddress();
    this.signature = await signer.signTypedData({ name: 'EqtyEvent', version: '3', chainId: 0 }, {}, this.parsedData);
  }
}

export class EventChain {
  id: string;
  events: Event[] = [];

  constructor(id: string) {
    this.id = id;
  }

  static from(value: { id?: string; events?: any[] }): EventChain {
    const chain = new EventChain(value.id || `0x${'00'.repeat(32)}`);
    chain.events = (value.events || []).map((eventLike) => {
      const event = new Event(eventLike.parsedData || eventLike.data || {});
      event.signerAddress = eventLike.signerAddress;
      event.signature = eventLike.signature;
      return event;
    });
    return chain;
  }

  toJSON(): { id: string; events: any[] } {
    return {
      id: this.id,
      events: this.events.map((event) => ({
        parsedData: event.parsedData,
        signerAddress: event.signerAddress,
        signature: event.signature,
      })),
    };
  }
}
