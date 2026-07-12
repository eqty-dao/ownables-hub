import { firstValueFrom } from 'rxjs';
import { take, timeout } from 'rxjs/operators';
import { HubStateRepository } from '../persistence/repos/hub-state.repository.js';
import { PostgresService } from '../persistence/postgres.service.js';
import { OwnableTransportService } from './ownable-transport.service.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('OwnableTransportService split-process public-event delivery', () => {
  const config = {
    getAppConfig: () => ({
      databaseUrl,
    }),
  };

  async function resetConnections(...services: PostgresService[]) {
    await Promise.all(services.map((service) => service.onModuleDestroy()));
  }

  it('delivers a separately indexed public event to an already-open subscriber without reconnect', async () => {
    const listenerDb = new PostgresService(config as any);
    const publisherDb = new PostgresService(config as any);
    const publisherRepo = new HubStateRepository(publisherDb);
    const listener = new OwnableTransportService(listenerDb);
    const publisher = new OwnableTransportService(publisherDb);
    const subjectId = `0x${'8'.repeat(64)}`;
    const indexedEvent = {
      source: '0x00000000000000000000000000000000000000cc',
      eventType: 'stack',
      data: '0xdeadbeef',
      blockNumber: 25,
      transactionHash: '0x123',
      transactionIndex: 2,
      logIndex: 4,
      timestamp: 1234,
    };

    await listener.onModuleInit();
    await publisher.onModuleInit();

    try {
      const receivedPromise = firstValueFrom(listener.watchPublicEvents().pipe(take(1), timeout(5000)));

      await publisherRepo.withIndexerPersistenceTransaction({
        slotName: 'testnet',
        cursorName: 'anchor-public-events',
        chainId: '84532',
        anchorContractAddress: '0x00000000000000000000000000000000000000aa',
        nextFromBlock: 26n,
        lastScannedBlock: 25n,
        lastScannedTxHash: indexedEvent.transactionHash,
        lastScannedTxIndex: indexedEvent.transactionIndex,
        lastScannedLogIndex: indexedEvent.logIndex,
        anchorEvents: [],
        publicEvents: [
          {
            slotName: 'testnet',
            chainId: '84532',
            anchorContractAddress: '0x00000000000000000000000000000000000000aa',
            blockNumber: BigInt(indexedEvent.blockNumber),
            blockHash: '0xabc',
            transactionHash: indexedEvent.transactionHash,
            transactionIndex: indexedEvent.transactionIndex,
            logIndex: indexedEvent.logIndex,
            eventName: 'PublicEvent',
            subjectId,
            sourceAddress: indexedEvent.source,
            eventType: indexedEvent.eventType,
            dataHex: indexedEvent.data,
            eventTimestamp: BigInt(indexedEvent.timestamp ?? 0),
            payloadJson: {
              subjectId,
              source: indexedEvent.source,
              eventType: indexedEvent.eventType,
              data: indexedEvent.data,
              timestamp: String(indexedEvent.timestamp),
            },
          },
        ],
      });

      publisher.publishPublicEvent({
        subjectId,
        publicEvent: indexedEvent,
      });

      await expect(receivedPromise).resolves.toEqual({
        subjectId,
        publicEvent: indexedEvent,
      });
    } finally {
      await Promise.all([listener.onModuleDestroy(), publisher.onModuleDestroy()]);
      await resetConnections(listenerDb, publisherDb);
    }
  });
});
