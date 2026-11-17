import type { HookEvent, ToolCall } from "../hook-event";

/**
 * One run of MCP calls whose tool windows overlap inside a unit. An MCP server can write
 * files that only the Git snapshot proves (ADR 0017), so a run of overlapping MCP calls
 * shares a single fence: the snapshot taken before the first call and the one taken after
 * the last. A batch of one is an ordinary single MCP call.
 */
export interface McpBatch {
  /** `tool_use_id` of the first call: its Pre snapshot fences the whole batch. */
  readonly baseId: string;
  /** Every member, in the order its `PreToolUse` arrived. */
  readonly memberIds: readonly string[];
  /**
   * The member whose `PostToolUse`/`PostToolUseFailure` completed last and therefore holds
   * the batch's diff. `null` while the batch is still open, and for good when a member
   * never closed.
   */
  readonly closerId: string | null;
  /** Members whose `PreToolUse` has no closing event yet; empty once the batch closed. */
  readonly openIds: readonly string[];
}

/** Where one MCP call sits inside its batch. */
export interface McpRole {
  readonly batch: McpBatch;
  /** `true` for the member that carries the batch's diff. */
  readonly closer: boolean;
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

/**
 * The maximal runs of overlapping MCP calls in event order. Overlap is transitive: a call
 * that starts while any member of the current batch is open joins that batch, and the
 * batch ends with the event that closes its last member. A call that starts after the
 * batch closed opens a new one, even with no other event in between.
 */
export function mcpBatches(events: readonly HookEvent[]): readonly McpBatch[] {
  const batches: McpBatch[] = [];
  let open: {
    baseId: string;
    memberIds: string[];
    openIds: Set<string>;
  } | null = null;

  for (const event of events) {
    const tool = toolOf(event);

    if (tool === null || tool.category !== "MCP") continue;

    if (event.name === "PreToolUse") {
      open ??= { baseId: tool.toolUseId, memberIds: [], openIds: new Set() };

      if (open.openIds.has(tool.toolUseId)) continue;

      open.memberIds.push(tool.toolUseId);
      open.openIds.add(tool.toolUseId);
      continue;
    }

    if (open === null || !open.openIds.delete(tool.toolUseId)) continue;

    if (open.openIds.size > 0) continue;

    batches.push({
      baseId: open.baseId,
      memberIds: open.memberIds,
      closerId: tool.toolUseId,
      openIds: [],
    });
    open = null;
  }

  if (open !== null) {
    batches.push({
      baseId: open.baseId,
      memberIds: open.memberIds,
      closerId: null,
      openIds: [...open.openIds],
    });
  }

  return batches;
}

/** Each MCP call of the unit with its batch and whether it carries the batch's diff. */
export function mcpRoles(events: readonly HookEvent[]): ReadonlyMap<string, McpRole> {
  const roles = new Map<string, McpRole>();

  for (const batch of mcpBatches(events)) {
    for (const id of batch.memberIds) {
      roles.set(id, { batch, closer: batch.closerId === id });
    }
  }

  return roles;
}

/** The batch still open at the end of the stream, or `null` when every batch closed. */
export function openMcpBatch(events: readonly HookEvent[]): McpBatch | null {
  const batches = mcpBatches(events);
  const [last] = batches.slice(-1);

  return last !== undefined && last.closerId === null ? last : null;
}
