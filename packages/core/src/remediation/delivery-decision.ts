import {
  type AgentDeliveryDecision,
  type AgentDeliveryDecisionInput,
  MAX_AGENT_DELIVERIES_PER_SESSION,
} from "./types";

/** True while a session has made fewer agent deliveries than the limit allows. */
export function withinSessionLimit(deliveredInSession: number): boolean {
  return deliveredInSession < MAX_AGENT_DELIVERIES_PER_SESSION;
}

/**
 * The delivery decision shared by both hosts: a unit that came from a delivery, or a
 * user who did not opt in to `delivery: agent`, only gets the panel; otherwise the
 * session limit decides between one delivery and none.
 */
export function decideAgentDelivery(input: AgentDeliveryDecisionInput): AgentDeliveryDecision {
  if (!input.agentOptIn || input.fromDelivery) {
    return "PANEL";
  }

  return withinSessionLimit(input.deliveredInSession) ? "DELIVER" : "SESSION_LIMIT";
}
