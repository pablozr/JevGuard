import { checkFilePath, DEFAULT_EVIDENCE_POLICY } from "@jevguard/core";
import type {
  HookEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ToolCall,
} from "../hook-event";
import type { AcquireUnitInput, UnitAttribution } from "./types";

function isShell(tool: ToolCall): boolean {
  return tool.category === "BASH" || tool.category === "POWERSHELL";
}

function isWriteCapable(tool: ToolCall): boolean {
  return tool.category === "EDIT" || isShell(tool);
}

function toolOf(event: HookEvent): ToolCall | null {
  switch (event.name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return event.tool;
    default:
      return null;
  }
}

function flagToolReasons(tool: ToolCall, state: UnitAttribution): void {
  if (tool.category === "MCP") state.reasons.add("MCP_TOOL");
  if (tool.category === "UNKNOWN") state.reasons.add("UNKNOWN_TOOL");
  if (isShell(tool) && tool.runInBackground) state.reasons.add("SHELL_BACKGROUND");
}

function flagPairing(events: readonly HookEvent[], state: UnitAttribution): void {
  const opened = new Set<string>();
  const closed = new Set<string>();

  for (const event of events) {
    const tool = toolOf(event);

    if (tool === null || !isWriteCapable(tool)) continue;

    if (event.name === "PreToolUse") opened.add(tool.toolUseId);
    else closed.add(tool.toolUseId);
  }

  const unpaired =
    [...opened].some((id) => !closed.has(id)) || [...closed].some((id) => !opened.has(id));

  if (unpaired) state.reasons.add("PAIRING_BROKEN");
}

function allowedRepoPath(
  rawPath: string,
  cwd: string,
  input: AcquireUnitInput,
  state: UnitAttribution,
): string | null {
  const repoPath = input.resolveRepoPath(rawPath, cwd);

  if (repoPath === null) {
    state.reasons.add("PATH_OUTSIDE_REPOSITORY");
    return null;
  }

  if (!checkFilePath(repoPath, DEFAULT_EVIDENCE_POLICY).allowed) {
    state.reasons.add("BLOCKED_PATH");
    return null;
  }

  return repoPath;
}

function editedPath(
  event: PreToolUseEvent | PostToolUseEvent,
  input: AcquireUnitInput,
  state: UnitAttribution,
): string | null {
  if (event.tool.filePath === null) {
    state.reasons.add("MISSING_PATH");
    return null;
  }

  return allowedRepoPath(event.tool.filePath, event.cwd, input, state);
}

function onPreToolUse(
  event: PreToolUseEvent,
  input: AcquireUnitInput,
  state: UnitAttribution,
): void {
  if (isShell(event.tool)) {
    state.universeAtShellStart.set(event.tool.toolUseId, new Set(state.universe));
    return;
  }

  if (event.tool.category !== "EDIT") return;

  const path = editedPath(event, input, state);

  if (path === null) return;

  const preImage = input.capture.preImages.get(path);

  if (preImage === undefined) {
    state.reasons.add("MISSING_CAPTURE");
    return;
  }

  if (state.universe.has(path)) return;

  state.universe.add(path);
  state.preImages.set(path, preImage);
}

function recordPostImage(
  path: string,
  toolUseId: string,
  input: AcquireUnitInput,
  state: UnitAttribution,
): void {
  const post = input.capture.postImages.get(toolUseId)?.get(path);

  if (post === undefined) {
    state.reasons.add("MISSING_CAPTURE");
    return;
  }

  state.lastPostImages.set(path, post);
}

function onEditPost(
  event: PostToolUseEvent,
  input: AcquireUnitInput,
  state: UnitAttribution,
): void {
  const path = editedPath(event, input, state);

  if (path === null) return;

  recordPostImage(path, event.tool.toolUseId, input, state);
}

function onEditFailed(
  event: PostToolUseFailureEvent,
  input: AcquireUnitInput,
  state: UnitAttribution,
): void {
  if (event.tool.filePath === null) return;

  const path = input.resolveRepoPath(event.tool.filePath, event.cwd);
  const preImage = path === null ? undefined : state.preImages.get(path);

  if (path === null || preImage === undefined || state.lastPostImages.has(path)) return;

  state.lastPostImages.set(
    path,
    preImage.state === "ABSENT" ? preImage : { state: "PRESENT", digest: preImage.digest },
  );
}

function onShellFinished(
  event: PostToolUseEvent | PostToolUseFailureEvent,
  input: AcquireUnitInput,
  state: UnitAttribution,
): void {
  if (event.tool.runInBackground) return;

  const diff = input.capture.gitDiffs.get(event.tool.toolUseId);

  if (diff === undefined || diff.status === "FAILED") {
    state.reasons.add("SHELL_GIT_DIFF_UNAVAILABLE");
    return;
  }

  const known = state.universeAtShellStart.get(event.tool.toolUseId) ?? state.universe;

  for (const change of diff.changes) {
    if (!checkFilePath(change.path, DEFAULT_EVIDENCE_POLICY).allowed) {
      state.reasons.add("BLOCKED_PATH");
      continue;
    }

    if (change.preState === "UNREAD") {
      state.reasons.add("MISSING_CAPTURE");
      continue;
    }

    if (known.has(change.path)) {
      state.lastPostImages.set(change.path, change.post);
      continue;
    }

    if (change.preState === "DIRTY") {
      state.reasons.add("SHELL_CHANGED_OUTSIDE_UNIVERSE");
      continue;
    }

    state.universe.add(change.path);
    state.preImages.set(change.path, change.indexImage);
    state.lastPostImages.set(change.path, change.post);
  }
}

function onPostToolUse(
  event: PostToolUseEvent,
  input: AcquireUnitInput,
  state: UnitAttribution,
): void {
  switch (event.tool.category) {
    case "EDIT":
      onEditPost(event, input, state);
      return;
    case "BASH":
    case "POWERSHELL":
      onShellFinished(event, input, state);
      return;
    default:
      return;
  }
}

/**
 * Walks the unit's tool events in order and builds the file universe, pre-images and
 * last attributed post-images. Every path passes `checkFilePath` before any capture
 * entry for it is read.
 */
export function attributeToolEvents(input: AcquireUnitInput): UnitAttribution {
  const state: UnitAttribution = {
    reasons: new Set(),
    universe: new Set(),
    preImages: new Map(),
    lastPostImages: new Map(),
    universeAtShellStart: new Map(),
  };

  flagPairing(input.unit.events, state);

  for (const event of input.unit.events) {
    const tool = toolOf(event);

    if (tool !== null) flagToolReasons(tool, state);

    if (event.name === "PreToolUse") onPreToolUse(event, input, state);
    if (event.name === "PostToolUse") onPostToolUse(event, input, state);
    if (event.name !== "PostToolUseFailure") continue;

    if (isShell(event.tool)) onShellFinished(event, input, state);
    if (event.tool.category === "EDIT") onEditFailed(event, input, state);
  }

  return state;
}
