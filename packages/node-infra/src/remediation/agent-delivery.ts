import { stringify } from "yaml";
import { parsePolicyConfig } from "../policy";
import { isInsideProject, parentOf, realPathOfNearest } from "./containment";
import type {
  AgentDeliveryBlock,
  AgentDeliveryInput,
  AgentDeliveryInspection,
  AgentDeliveryResult,
} from "./types";
import { isRecord, resolveRemediationUserSettings, userConfigFileOf } from "./user-settings";

const SECTION_KEY = "remediation";

type Plan =
  | { readonly status: "READY"; readonly path: string; readonly text: string }
  | { readonly status: "ALREADY_ENABLED"; readonly path: string }
  | {
      readonly status: AgentDeliveryBlock;
      readonly path: string | null;
    };

type ExistingFile =
  | { readonly status: "READ"; readonly value: unknown }
  | { readonly status: "UNREADABLE" };

/** Reports whether the user's host file already enables `delivery: agent`; it never writes. */
export async function inspectAgentDelivery(
  input: AgentDeliveryInput,
): Promise<AgentDeliveryInspection> {
  const plan = await planAgentDelivery(input);

  if (plan.status === "READY") return { status: "WOULD_ENABLE", path: plan.path };

  return { status: plan.status, path: plan.path };
}

/**
 * Turns on `remediation: { enabled: true, delivery: agent }` in the user's host file,
 * keeping a valid `model`. It refuses a file inside the project and never touches an
 * invalid existing file.
 */
export async function enableAgentDelivery(input: AgentDeliveryInput): Promise<AgentDeliveryResult> {
  const plan = await planAgentDelivery(input);

  if (plan.status !== "READY") return { status: plan.status, path: plan.path };

  try {
    const directory = parentOf(plan.path);

    if (directory !== null) await input.files.makeDirectory(directory);

    await input.files.writeTextAtomic(plan.path, plan.text);
  } catch {
    return { status: "WRITE_FAILED", path: plan.path };
  }

  return { status: "ENABLED", path: plan.path };
}

async function planAgentDelivery(input: AgentDeliveryInput): Promise<Plan> {
  const path = userConfigFileOf(input.environment, input.fileName);

  if (path === null) return { status: "NO_CONFIG_HOME", path: null };

  if (isInsideUserProject(path, input)) return { status: "INSIDE_PROJECT", path };

  const existing = await readExisting(input, path);

  if (existing.status === "UNREADABLE") return { status: "INVALID_EXISTING", path };

  const resolved = resolveRemediationUserSettings(existing.value, input.rules);

  if (resolved.status === "INVALID") return { status: "INVALID_EXISTING", path };

  if (resolved.status === "ENABLED" && resolved.settings.delivery === "agent") {
    return { status: "ALREADY_ENABLED", path };
  }

  return { status: "READY", path, text: stringify(withAgentDelivery(existing.value)) };
}

function isInsideUserProject(path: string, input: AgentDeliveryInput): boolean {
  try {
    const real = realPathOfNearest(path, input.probe) ?? path;

    return isInsideProject(real, input.projectRoot, input.probe);
  } catch {
    return true;
  }
}

async function readExisting(input: AgentDeliveryInput, path: string): Promise<ExistingFile> {
  try {
    const text = await input.files.readText(path);

    if (text === null || text.trim() === "") return { status: "READ", value: null };

    const parsed = parsePolicyConfig(text);

    return parsed.status === "PARSED"
      ? { status: "READ", value: parsed.value }
      : { status: "UNREADABLE" };
  } catch {
    return { status: "UNREADABLE" };
  }
}

function withAgentDelivery(existing: unknown): Record<string, unknown> {
  const section = sectionOf(existing);
  const model = section.model;

  return {
    [SECTION_KEY]: {
      enabled: true,
      delivery: "agent",
      ...(typeof model === "string" ? { model } : {}),
    },
  };
}

function sectionOf(existing: unknown): Record<string, unknown> {
  const section = isRecord(existing) ? existing[SECTION_KEY] : undefined;

  return isRecord(section) ? section : {};
}
