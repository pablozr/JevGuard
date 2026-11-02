import {
  type ChainClosure,
  type ChainState,
  MAX_AGENT_DELIVERIES_PER_SESSION,
} from "@jevguard/core";

/** Chains kept in memory at once; the oldest one is dropped (and ends as `EXPIRED`) past it. */
export const MAX_ACTIVE_CHAINS = 64;

/**
 * In-memory remediation chains for one plugin process (OpenCode 2.2.x), by chain id, plus
 * the agent deliveries each session made. Nothing is written to disk: a restart ends every
 * chain, and the next correction turn is then read as unverified.
 */
export interface RemediationChains {
  load(chainId: string): ChainState | null;
  /** Saves a chain's state for `sessionID`; returns the chains that were dropped to make room. */
  save(sessionID: string, state: ChainState): readonly ChainClosure[];
  remove(chainId: string): void;
  /** The newest chain of a session, or `null` when it has none. */
  activeChain(sessionID: string): ChainState | null;
  /** Counts one more delivery for `sessionID`; `false`, and nothing counted, past the limit. */
  countDelivery(sessionID: string): boolean;
}

export function createRemediationChains(maxChains: number = MAX_ACTIVE_CHAINS): RemediationChains {
  const chains = new Map<string, { readonly sessionID: string; readonly state: ChainState }>();
  const deliveries = new Map<string, number>();

  return {
    load(chainId) {
      return chains.get(chainId)?.state ?? null;
    },

    save(sessionID, state) {
      const known = chains.has(state.chainId);

      chains.set(state.chainId, { sessionID, state });

      if (known) return [];

      const dropped: ChainClosure[] = [];

      for (const [chainId, entry] of chains) {
        if (chains.size <= maxChains) break;

        chains.delete(chainId);
        dropped.push({ state: entry.state, code: "EXPIRED" });
      }

      return dropped;
    },

    remove(chainId) {
      chains.delete(chainId);
    },

    activeChain(sessionID) {
      let newest: ChainState | null = null;

      for (const entry of chains.values()) {
        if (entry.sessionID === sessionID) newest = entry.state;
      }

      return newest;
    },

    countDelivery(sessionID) {
      const count = deliveries.get(sessionID) ?? 0;

      if (count >= MAX_AGENT_DELIVERIES_PER_SESSION) return false;

      deliveries.set(sessionID, count + 1);

      return true;
    },
  };
}
