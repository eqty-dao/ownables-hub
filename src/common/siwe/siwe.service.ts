import { Injectable } from '@nestjs/common';
import { verifyTypedData, isAddress } from 'ethers';
import { randomBytes } from 'crypto';
import { ConfigService } from '../config/config.service.js';

export interface SIWEMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export interface SIWEAuthResult {
  isValid: boolean;
  address?: string;
  error?: string;
}

@Injectable()
export class SIWEService {
  private readonly domain: string;
  private readonly version = '1';

  constructor(private readonly config: ConfigService) {
    this.domain = this.config.get('siwe.domain');
  }

  async verifySIWEMessage(message: SIWEMessage, signature: string): Promise<SIWEAuthResult> {
    try {
      if (!signature || !signature.startsWith('0x')) {
        return { isValid: false, error: 'Invalid signature format' };
      }
      if (!isAddress(message.address)) {
        return { isValid: false, error: 'Invalid Ethereum address' };
      }
      if (message.domain !== this.domain) {
        return { isValid: false, error: 'Invalid SIWE domain' };
      }

      const domain = {
        name: 'Sign-In with Ethereum',
        version: this.version,
        chainId: message.chainId,
      };

      const types = {
        Message: [
          { name: 'domain', type: 'string' },
          { name: 'address', type: 'address' },
          { name: 'statement', type: 'string' },
          { name: 'uri', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'nonce', type: 'string' },
          { name: 'issuedAt', type: 'string' },
          { name: 'expirationTime', type: 'string' },
          { name: 'notBefore', type: 'string' },
          { name: 'requestId', type: 'string' },
          { name: 'resources', type: 'string[]' },
        ],
      };

      const value = {
        domain: message.domain,
        address: message.address,
        statement: message.statement || '',
        uri: message.uri,
        version: message.version,
        chainId: message.chainId,
        nonce: message.nonce,
        issuedAt: message.issuedAt,
        expirationTime: message.expirationTime || '',
        notBefore: message.notBefore || '',
        requestId: message.requestId || '',
        resources: message.resources || [],
      };

      const recoveredAddress = await verifyTypedData(domain, types, value, signature);
      if (recoveredAddress.toLowerCase() !== message.address.toLowerCase()) {
        return { isValid: false, error: 'Signature does not match message address', address: recoveredAddress };
      }

      if (message.expirationTime && new Date(message.expirationTime) < new Date()) {
        return { isValid: false, error: 'Message has expired' };
      }
      if (message.notBefore && new Date(message.notBefore) > new Date()) {
        return { isValid: false, error: 'Message is not yet valid' };
      }

      return { isValid: true, address: recoveredAddress };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isValid: false, error: `SIWE verification failed: ${message}` };
    }
  }

  generateNonce(): string {
    return randomBytes(16).toString('hex');
  }
}
