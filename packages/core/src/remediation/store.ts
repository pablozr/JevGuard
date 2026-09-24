import type { RemediationProposalStore } from "./types";

/**
 * Creates the in-memory, single-instance proposal store. `claim` is synchronous, so
 * concurrent or out-of-order reviews of the same evaluated turn cannot both create a
 * proposal, while different turns and different sessions stay independent. Child
 * sessions are registered by identity and excluded from review for the plugin
 * lifetime, so a proposal turn can never trigger another review or proposal.
 */
export function createRemediationProposalStore(): RemediationProposalStore {
  const claimed = new Set<string>();
  const childSessions = new Set<string>();

  return {
    claim(evaluationId) {
      if (evaluationId === "" || claimed.has(evaluationId)) {
        return false;
      }

      claimed.add(evaluationId);

      return true;
    },

    registerChildSession(sessionID) {
      if (sessionID !== "") {
        childSessions.add(sessionID);
      }
    },

    isChildSession(sessionID) {
      return childSessions.has(sessionID);
    },
  };
}
