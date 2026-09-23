import type { ReviewBridgePayload } from "@jevguard/core";
import { decodeBridgeCommand } from "./bridge";
import {
  buildProposalParts,
  buildRemediationParts,
  disabledToolMap,
  PROPOSAL_SYSTEM_INSTRUCTION,
  REMEDIATION_SYSTEM_INSTRUCTION,
} from "./prompts";
import { retrieveProposalContext } from "./retrieve";
import type { RemediationDependencies, RemediationWorkflow, TuiNotifier } from "./types";

const GENERIC_FAILURE = "JevGuard remediation could not continue.";
const UNVERIFIED_EVIDENCE = "JevGuard could not verify the attributed change.";
const MISSING_STRATEGY = "JevGuard did not receive a remediation strategy.";

/**
 * One proposal and at most one approved remediation per evaluation ID. Every valid
 * distinct evaluation is handled in global arrival order behind a single queue: a
 * second valid failure — from the same or another session — waits for the previous
 * dialog to be canceled or completed instead of replacing it, because the host
 * exposes one global dialog stack. Invalid, non-prefix, and duplicate commands are
 * ignored silently; a valid command whose evidence cannot be fully verified, whose
 * tool list cannot be read, or whose proposal cannot be produced surfaces a safe
 * status message and stops. A failure in one queued command is contained and never
 * prevents the next. Remediation runs only after explicit confirmation, as a distinct
 * interaction, and this workflow never triggers a second evaluation.
 */
export function createRemediationWorkflow(
  dependencies: RemediationDependencies,
): RemediationWorkflow {
  const processed = new Set<string>();
  let tail: Promise<void> = Promise.resolve();

  function handleCommand(command: string): Promise<void> {
    const decoded = decodeBridgeCommand(command);

    if (decoded.status !== "DECODED") {
      return Promise.resolve();
    }

    const payload = decoded.payload;

    if (processed.has(payload.evaluationId)) {
      return Promise.resolve();
    }

    processed.add(payload.evaluationId);

    const current = tail
      .then(() => runDecoded(payload))
      .catch(() => {
        notify(dependencies.notify, "error", GENERIC_FAILURE);
      });

    tail = current;

    return current.finally(() => {
      if (tail === current) {
        tail = Promise.resolve();
      }
    });
  }

  async function runDecoded(payload: ReviewBridgePayload): Promise<void> {
    const context = await retrieveProposalContext(payload, dependencies.reader);

    if (context.status !== "OK") {
      notify(dependencies.notify, "error", UNVERIFIED_EVIDENCE);
      return;
    }

    const ids = await dependencies.tools.listToolIds();

    if (ids.status !== "OK") {
      notify(dependencies.notify, "error", GENERIC_FAILURE);
      return;
    }

    const proposal = await dependencies.prompts.send({
      sessionID: payload.sessionID,
      system: PROPOSAL_SYSTEM_INSTRUCTION,
      parts: buildProposalParts(context.value),
      tools: disabledToolMap(ids.value),
    });

    if (proposal.status !== "OK" || proposal.value.trim() === "") {
      notify(dependencies.notify, "error", MISSING_STRATEGY);
      return;
    }

    const strategy = proposal.value.trim();
    const decision = await dependencies.dialogs.confirm({ ruleId: payload.rule.id, strategy });

    if (decision !== "APPLY") {
      return;
    }

    const applied = await dependencies.prompts.send({
      sessionID: payload.sessionID,
      system: REMEDIATION_SYSTEM_INSTRUCTION,
      parts: buildRemediationParts(context.value, strategy),
    });

    if (applied.status !== "OK") {
      notify(dependencies.notify, "error", GENERIC_FAILURE);
      return;
    }

    notify(dependencies.notify, "success", "JevGuard remediation sent.");
  }

  return { handleCommand };
}

function notify(
  notifier: TuiNotifier,
  variant: "info" | "success" | "warning" | "error",
  message: string,
): void {
  try {
    notifier.notify({ variant, message });
  } catch {
    return;
  }
}
