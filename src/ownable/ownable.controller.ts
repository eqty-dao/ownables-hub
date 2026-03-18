import { Controller, Get, Header, Param, Query, Post, Req, Res, UseInterceptors, StreamableFile } from '@nestjs/common';
import { ApiBody, ApiProperty, ApiConsumes, ApiProduces } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { OwnableService } from './ownable.service';
import { Account, EventChain } from '@ltonetwork/lto';
import { eventChainExample } from './examples';
import { Signer } from '../common/http-signature/signer';
import { AuthError, UserError } from '../interfaces/error';
import { FileInterceptor } from '@nestjs/platform-express';
import { NFTInfo } from '../interfaces/OwnableInfo';

@Controller('ownables')
export class OwnableController {
  constructor(private ownableService: OwnableService) { }

  @Post('/bridge')
  @ApiConsumes('multipart/form-data')
  @ApiProperty({ type: 'string', format: 'binary' })
  @ApiBody({
    description: 'Zipped Ownable package',
    required: true,
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async bridgeOwnable(@Req() req: Request, @Res() res: Response, @Signer() signer: Account): Promise<Response> {
    const buffer = req.file.buffer;
    if (!buffer || Object.getPrototypeOf(buffer) === null || Object.prototype.isPrototypeOf(buffer) == false) {
      return res.status(400).send('Failed to read data from HTTP request');
    }
    // TODO: enable the following check
    // if (signer == undefined) {
    //   return res.status(400).send('Signer of HTTP request is undefined');
    // }
    try {
      const bridgedOwnableInfo = await this.ownableService.bridgeOwnable(buffer, signer, true);
      return res.status(201).json(bridgedOwnableInfo);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }
  @Get('claim')
  @Header('Content-type', 'application/zip')
  @ApiProduces('application/zip')
  async claim(
    @Query('cid') cid: string,
    @Query('message') message: string,
    @Query('signature') signature: string,
    @Res() res: Response,
    @Signer() signer?: Account,
  ): Promise<StreamableFile | Response> {
    try {
      // TODO: add verbose as query parameter ?
      return await this.ownableService.claimOwnable(cid, message, signature, signer, true);
    } catch (err) {
      return this.errorResponse(res, err);
    }
  }

  private errorResponse(res: Response, err: any) {
    if (err instanceof AuthError) return res.status(403).send(err.message);
    if (err instanceof UserError) return res.status(400).send(err.message);

    console.error(err);
    return res.status(500).send('Unexpected error');
  }

  @Get('testSignedRequest')
  async testSignedRequest() {
    try {
      return await this.ownableService.testSignedRequest();
    } catch (e) {
      return { error: `${e}` };
    }
  }

  @Get('proof')
  async getUnlockProof(@Query('cid') cid: string, @Signer() signer: Account) {
    try {
      const unlockProof = await this.ownableService.getUnlockProof(cid, signer);
      return { unlockProof: unlockProof };
    } catch (e) {
      return { error: `${e}` };
    }
  }
  @Get('isUnlockProofValid')
  async isUnlockProofValid(
    @Query('network') network: string,
    @Query('address') address: string,
    @Query('id') id: string,
    @Query('proof') proof: string,
  ) {
    try {
      const unlockProofvalid = await this.ownableService.isUnlockProofValid(network, address, id, proof);
      return { isUnlockProofValid: unlockProofvalid };
    } catch (e) {
      return { error: `${e}` };
    }
  }
  @Get('bridged')
  getBridgedOwnableCIDs(@Signer() signer: Account) {
    try {
      return { bridgedOwnables: `${this.ownableService.getBridgedOwnableCIDs(signer)}` };
    } catch (e) {
      return { error: `${e}` };
    }
  }
  @Get('serverwallet')
  serverWalletAddressLTO() {
    try {
      return { serverWalletAddressLTO: `${this.ownableService.getServerLTOwalletAddress()}` };
    } catch (e) {
      return { error: `${e}` };
    }
  }
  @Get('chains')
  async GetAvailableNftChains() {
    try {
      return await this.ownableService.getAvailableNftChains();
    } catch (e) {
      return { error: `${e}` };
    }
  }
  @Get('cid')
  async getOwnableCidFromNFT(
    @Query('network') network: string,
    @Query('address') address: string,
    @Query('id') id: string,
  ) {
    try {
      return await this.ownableService.getOwnableCidFromNFT({ network: network, address: address, id: id });
    } catch (e) {
      return { error: `${e}` };
    }
  }
  @Get('serverinfo')
  async GetServerInfo() {
    try {
      const ethBalance = await this.ownableService.GetServerETHBalance('eip155:ethereum');
      const baseBalance = await this.ownableService.GetServerETHBalance('eip155:base');
      const ltoBalance = await this.ownableService.getLTOAccountBalance();
      const serverLTOwallet = this.ownableService.getServerLTOwalletAddress();
      // console.log("balance", balance);
      return {
        ServerEthereumBalance: ethBalance,
        ServerBaseBalance: baseBalance,
        ServerLTOBalance: ltoBalance,
        serverLTOwalletAddress: serverLTOwallet,
      };
    } catch (e) {
      return { error: `${e}` };
    }
  }

  // @Post('/')
  // @ApiConsumes('application/json', 'application/yaml')
  // @ApiBody({
  //   schema: {
  //     type: 'object',
  //     example: eventChainExample,
  //   },
  //   description: 'Event chain',
  //   required: true,
  // })
  // async submit(@Req() req: Request, @Res() res: Response, @Signer() signer?: Account): Promise<Response> {
  //   const eventChainJson = req.body;
  //   if (!eventChainJson) {
  //     res.status(400).send('Failed to read event chain request');
  //     return;
  //   }

  //   try {
  //     await this.ownableService.accept(EventChain.from(eventChainJson), signer);
  //     return res.status(201).send('Created');
  //   } catch (err) {
  //     return this.errorResponse(res, err);
  //   }
  // }
}
