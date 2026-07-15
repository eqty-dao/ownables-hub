import { Injectable } from '@nestjs/common';
import {
  AnchorValidationService,
  EventChainService,
  OwnableService as CoreOwnableService,
  PublicEventReplayService,
  type AnchorProvider,
  type IndexedAnchorRecord,
  type IndexedPublicEvent,
  type PackageAssetIO,
  type StateStore,
} from '@ownables/core';
import { NodeRuntimeRpcProvider, NodeRuntimeSourceProvider } from '@ownables/platform-node';

@Injectable()
export class OwnableReplayService {
  constructor(
    private readonly anchorValidation: AnchorValidationService,
    private readonly publicEventReplay: PublicEventReplayService,
  ) {}

  validateAnchors(anchors: Array<{ key: { hex: string }; value: { hex: string } }>, records: IndexedAnchorRecord[]) {
    return this.anchorValidation.validateAgainstIndexedRecords(anchors, records);
  }

  freshness(events: IndexedPublicEvent[], appliedReplayKeys: Iterable<string>, ignoredReplayKeys: Set<string>) {
    return this.publicEventReplay.evaluateFreshness(
      events.filter((event) => !ignoredReplayKeys.has(this.publicEventReplay.key(event))),
      appliedReplayKeys,
    );
  }

  createRuntime(stateStore: StateStore, anchorProvider: AnchorProvider, packages: PackageAssetIO) {
    const eventChains = new EventChainService(stateStore, anchorProvider, this.anchorValidation);
    const ownables = new CoreOwnableService({
      stateStore,
      eventChains,
      anchorProvider,
      packages,
      runtimeSource: new NodeRuntimeSourceProvider(),
      runtimeRpc: new NodeRuntimeRpcProvider(),
      replay: this.publicEventReplay,
      logger: console,
    });
    return { eventChains, ownables };
  }
}
