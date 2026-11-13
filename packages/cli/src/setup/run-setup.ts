import { applyStep, type StepOutcome } from "./apply";
import {
  describePlan,
  nextSteps,
  lineOf,
  noHostMessage,
  questionOf,
  SETUP_NOT_CONFIRMED_MESSAGE,
} from "./messages";
import { buildSetupPlan } from "./plan";
import type { SetupPorts, SetupRequest, SetupResult, SetupStep } from "./types";

type Decision = "APPLY" | "DECLINED" | "NO_TERMINAL";

type Consent = "ASK" | "OFFER" | "FLAGGED";

interface StepRecord {
  readonly step: SetupStep;
  readonly decision: Decision;
  readonly outcome: StepOutcome;
}

function consentOf(step: SetupStep): Consent {
  if (step.kind !== "POLICY" && step.kind !== "AGENT_DELIVERY") return "ASK";

  return step.requested ? "FLAGGED" : "OFFER";
}

async function decide(
  ports: SetupPorts,
  request: SetupRequest,
  step: SetupStep,
): Promise<Decision> {
  const consent = consentOf(step);

  if (consent === "OFFER" && request.yes) return "DECLINED";

  if (request.yes || consent === "FLAGGED") return "APPLY";

  const answer = await ports.context.confirmation.confirm(questionOf(step));

  if (answer.status === "CONFIRMED") return "APPLY";

  return answer.status === "DECLINED" ? "DECLINED" : "NO_TERMINAL";
}

function hasHost(steps: readonly SetupStep[]): boolean {
  return steps.some((step) => step.kind === "INSTALL");
}

async function resolve(
  ports: SetupPorts,
  request: SetupRequest,
  step: SetupStep,
): Promise<StepRecord | null> {
  const decision = await decide(ports, request, step);

  if (decision === "NO_TERMINAL") return null;

  const outcome =
    decision === "APPLY"
      ? await applyStep(ports, step)
      : { ok: true, lines: [`Skipped: ${lineOf(step)}`] };

  return { step, decision, outcome };
}

function isCredentialMissing(records: readonly StepRecord[]): boolean {
  return records.some(
    (record) =>
      record.step.kind === "CREDENTIAL" && (record.decision !== "APPLY" || !record.outcome.ok),
  );
}

/**
 * Plans the setup and applies it. Without `--yes` every change needs an interactive yes;
 * without a terminal nothing is applied. A starter `.jev/rules.md` is created only with
 * `--init` or after an interactive yes.
 */
export async function runSetup(ports: SetupPorts, request: SetupRequest): Promise<SetupResult> {
  const plan = await buildSetupPlan(ports, request);
  const lines = [...describePlan(plan)];

  if (!hasHost(plan.steps)) {
    return { status: "NO_HOST", lines: [...lines, noHostMessage(ports.extensions)] };
  }

  const pending = plan.steps.filter((step) => step.status === "PENDING");

  if (pending.length === 0) {
    return { status: "NOTHING_TO_DO", lines: [...lines, "Nothing to do.", ...nextSteps(false)] };
  }

  const records: StepRecord[] = [];

  for (const step of pending) {
    const record = await resolve(ports, request, step);

    if (record === null) {
      return { status: "NOT_CONFIRMED", lines: [...lines, SETUP_NOT_CONFIRMED_MESSAGE] };
    }

    records.push(record);
  }

  const failed = records.some((record) => !record.outcome.ok);

  return {
    status: failed ? "FAILED" : "APPLIED",
    lines: [
      ...lines,
      ...records.flatMap((record) => record.outcome.lines),
      ...nextSteps(isCredentialMissing(records)),
    ],
  };
}
