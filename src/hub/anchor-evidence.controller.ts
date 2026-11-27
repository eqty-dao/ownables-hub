import { Body, Controller, HttpCode, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConfigService, HubNetwork } from '../common/config/config.service';
import { throwHttpError } from '../common/http/http-error-response';
import { UserError } from '../interfaces/error';
import { HubStateRepository } from '../persistence/repos/hub-state.repository';

const MAX_ANCHOR_PAIRS = 100;
const anchorKey = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;

@Controller(':network/anchors')
@ApiTags('anchor evidence')
export class AnchorEvidenceController {
  constructor(
    private readonly config: ConfigService,
    private readonly repository: HubStateRepository,
  ) {}

  @Post('evidence')
  @HttpCode(200)
  @ApiParam({ name: 'network', enum: ['base', 'base-sepolia'] satisfies HubNetwork[] })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['anchors'],
      properties: {
        anchors: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ANCHOR_PAIRS,
          items: {
            type: 'object',
            required: ['key', 'signer'],
            properties: {
              key: { type: 'string', pattern: anchorKey.source },
              signer: { type: 'string', pattern: address.source },
            },
          },
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Latest indexed anchor per requested key and signer, with network and contract provenance',
  })
  async evidence(@Param('network') network: string, @Body() body: unknown) {
    try {
      const context = this.config.resolveHubNetwork(network);
      const anchors = this.readPairs(body);
      if (!context.anchorContractAddress) {
        throw new ServiceUnavailableException('This network has no configured Anchor contract');
      }
      const records = await this.repository.findLatestAnchorEvidence(anchors, {
        slotName: context.slotName,
        chainId: context.chainId,
        anchorContractAddress: context.anchorContractAddress,
      });
      return {
        chainId: Number(context.chainId),
        anchorContractAddress: context.anchorContractAddress,
        records: records.map((record) => ({ ...record, blockNumber: Number(record.blockNumber) })),
      };
    } catch (error) {
      throwHttpError(error);
    }
  }

  private readPairs(body: unknown): Array<{ key: string; signer: string }> {
    const anchors = (body as { anchors?: unknown } | null)?.anchors;
    if (!Array.isArray(anchors) || anchors.length === 0 || anchors.length > MAX_ANCHOR_PAIRS) {
      throw new UserError(`anchors must contain between 1 and ${MAX_ANCHOR_PAIRS} key and signer pairs`);
    }
    const pairs = new Map<string, { key: string; signer: string }>();
    for (const pair of anchors) {
      if (
        typeof pair?.key !== 'string' ||
        !anchorKey.test(pair.key) ||
        typeof pair.signer !== 'string' ||
        !address.test(pair.signer)
      ) {
        throw new UserError('Each anchor must have a 32-byte hex key and an EVM signer address');
      }
      const key = pair.key.toLowerCase();
      const signer = pair.signer.toLowerCase();
      pairs.set(`${key}:${signer}`, { key, signer });
    }
    return [...pairs.values()];
  }
}
