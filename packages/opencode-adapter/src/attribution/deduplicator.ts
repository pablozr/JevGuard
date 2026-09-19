import type { TurnDeduplicator } from "./types";

export class InMemoryTurnDeduplicator implements TurnDeduplicator {
  private readonly processed = new Set<string>();

  hasProcessed(assistantMessageID: string): boolean {
    return this.processed.has(assistantMessageID);
  }

  markProcessed(assistantMessageID: string): void {
    this.processed.add(assistantMessageID);
  }
}
