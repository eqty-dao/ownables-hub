import { Injectable, Logger } from '@nestjs/common';
import { Interface, JsonRpcProvider, Log } from 'ethers';
import { ConfigService, IndexerSlotConfig } from '../common/config/config.service.js';
import { HubStateRepository, type IndexerCursorState } from '../persistence/repos/hub-state.repository.js';
import { OwnableTransportService } from '../ownable/ownable-transport.service.js';

const ANCHOR_CURSOR_NAME = 'anchor-public-events';

const ANCHOR_EVENT_ABI = [
  'event Anchored(bytes32 indexed key, bytes32 value, address indexed sender, uint64 timestamp)',
  'event PublicEvent(bytes32 indexed subjectId, address indexed source, string eventType, bytes data, uint64 timestamp)',
] as const;

type NormalizedIndexedEvent = {
  eventKind: 'anchor' | 'public';
  slotName: 'testnet' | 'mainnet';
  chainId: string;
  anchorContractAddress: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  eventName: string;
  cid: string | null;
  ownerAddress: string | null;
  subjectId: string | null;
  sourceAddress: string | null;
  eventType: string | null;
  dataHex: string | null;
  eventTimestamp: bigint | null;
  payloadJson: unknown;
};

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  private readonly eventIface = new Interface([...ANCHOR_EVENT_ABI]);

  constructor(
    private readonly configService: ConfigService,
    private readonly hubStateRepository: HubStateRepository,
    private readonly ownableTransport: OwnableTransportService,
  ) {}

  async runAllSlots(): Promise<void> {
    const slots = this.configService.getIndexerSlots();
    for (const slot of slots) {
      await this.runSlot(slot);
    }
  }

  async runSlot(slot: IndexerSlotConfig): Promise<void> {
    const provider = new JsonRpcProvider(slot.rpcUrl);
    const head = await provider.getBlockNumber();
    const cursor = await this.hubStateRepository.getIndexerCursor(
      slot.slotName,
      ANCHOR_CURSOR_NAME,
      slot.chainId,
      slot.anchorContractAddress,
    );

    const fromBlock = this.resolveFromBlock(slot, cursor);
    const toBlock = BigInt(head);
    if (fromBlock > toBlock) {
      this.logger.log(`Slot ${slot.slotName}: no new blocks (from=${fromBlock.toString()}, head=${toBlock.toString()})`);
      return;
    }

    const rawLogs = await provider.getLogs({
      address: slot.anchorContractAddress,
      fromBlock: Number(fromBlock),
      toBlock: Number(toBlock),
    });

    const normalized = this.normalizeLogs(rawLogs, slot);
    const anchorEvents = normalized.filter((event) => event.eventKind === 'anchor');
    const publicEvents = normalized.filter((event) => event.eventKind === 'public');
    const tail = normalized.at(-1) ?? null;

    await this.hubStateRepository.withIndexerPersistenceTransaction({
      slotName: slot.slotName,
      cursorName: ANCHOR_CURSOR_NAME,
      chainId: slot.chainId,
      anchorContractAddress: slot.anchorContractAddress,
      nextFromBlock: toBlock + 1n,
      lastScannedBlock: tail?.blockNumber ?? toBlock,
      lastScannedTxHash: tail?.transactionHash ?? null,
      lastScannedTxIndex: tail?.transactionIndex ?? null,
      lastScannedLogIndex: tail?.logIndex ?? null,
      anchorEvents: anchorEvents.map((event) => ({
        slotName: event.slotName,
        chainId: event.chainId,
        anchorContractAddress: event.anchorContractAddress,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        eventName: event.eventName,
        cid: event.cid,
        ownerAddress: event.ownerAddress,
        payloadJson: event.payloadJson,
      })),
      publicEvents: publicEvents.map((event) => ({
        slotName: event.slotName,
        chainId: event.chainId,
        anchorContractAddress: event.anchorContractAddress,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        eventName: event.eventName,
        subjectId: event.subjectId,
        sourceAddress: event.sourceAddress,
        eventType: event.eventType,
        dataHex: event.dataHex,
        eventTimestamp: event.eventTimestamp,
        payloadJson: event.payloadJson,
      })),
    });
    for (const event of publicEvents) {
      if (!event.subjectId || !event.sourceAddress || !event.eventType || !event.dataHex) {
        continue;
      }
      this.ownableTransport.publishPublicEvent({
        subjectId: event.subjectId,
        publicEvent: {
          source: event.sourceAddress,
          eventType: event.eventType,
          data: event.dataHex,
          blockNumber: Number(event.blockNumber),
          transactionHash: event.transactionHash,
          transactionIndex: event.transactionIndex,
          logIndex: event.logIndex,
          timestamp: event.eventTimestamp ? Number(event.eventTimestamp) : undefined,
        },
      });
    }

    this.logger.log(
      `Slot ${slot.slotName}: indexed ${normalized.length} logs (${anchorEvents.length} anchor, ${publicEvents.length} public) from block ${fromBlock.toString()} to ${toBlock.toString()}`,
    );
  }

  private resolveFromBlock(slot: IndexerSlotConfig, cursor: IndexerCursorState | null): bigint {
    if (!cursor) {
      return slot.anchorStartBlock;
    }

    if (
      cursor.chainId !== slot.chainId ||
      cursor.anchorContractAddress.toLowerCase() !== slot.anchorContractAddress.toLowerCase()
    ) {
      return slot.anchorStartBlock;
    }

    return cursor.nextFromBlock >= slot.anchorStartBlock ? cursor.nextFromBlock : slot.anchorStartBlock;
  }

  private normalizeLogs(logs: Log[], slot: IndexerSlotConfig): NormalizedIndexedEvent[] {
    const events: NormalizedIndexedEvent[] = [];

    for (const log of logs) {
      let parsed;
      try {
        parsed = this.eventIface.parseLog(log);
      } catch {
        continue;
      }

      if (!parsed) {
        continue;
      }

      const eventKind = parsed.name === 'Anchored' ? 'anchor' : parsed.name === 'PublicEvent' ? 'public' : null;
      if (!eventKind) {
        continue;
      }

      const anchorKey = eventKind === 'anchor' ? this.asNullableString(parsed.args.key)?.toLowerCase() ?? null : null;
      const anchorValue = eventKind === 'anchor' ? this.asNullableString(parsed.args.value)?.toLowerCase() ?? null : null;
      const ownerAddress = eventKind === 'anchor' ? this.asNullableString(parsed.args.sender)?.toLowerCase() ?? null : null;
      const subjectId = eventKind === 'public' ? this.asNullableString(parsed.args.subjectId)?.toLowerCase() ?? null : null;
      const sourceAddress = eventKind === 'public' ? this.asNullableString(parsed.args.source)?.toLowerCase() ?? null : null;
      const eventType = eventKind === 'public' ? this.asNullableString(parsed.args.eventType) : null;
      const dataHex = eventKind === 'public' ? this.asNullableString(parsed.args.data)?.toLowerCase() ?? null : null;
      const rawTimestamp = parsed.args.timestamp;
      const eventTimestamp =
        rawTimestamp === null || rawTimestamp === undefined
          ? null
          : typeof rawTimestamp === 'bigint'
            ? rawTimestamp
            : BigInt(String(rawTimestamp));

      events.push({
        eventKind,
        slotName: slot.slotName,
        chainId: slot.chainId,
        anchorContractAddress: slot.anchorContractAddress,
        blockNumber: BigInt(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        eventName: parsed.name,
        cid: null,
        ownerAddress,
        subjectId,
        sourceAddress,
        eventType,
        dataHex,
        eventTimestamp,
        payloadJson:
          eventKind === 'public'
            ? {
                subjectId,
                source: sourceAddress,
                eventType,
                data: dataHex,
                timestamp: eventTimestamp?.toString() ?? null,
              }
            : {
                key: anchorKey,
                value: anchorValue,
                ownerAddress,
                timestamp: eventTimestamp?.toString() ?? null,
              },
      });
    }

    return events.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });
  }

  private asNullableString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const converted = String(value).trim();
    return converted ? converted : null;
  }
}
