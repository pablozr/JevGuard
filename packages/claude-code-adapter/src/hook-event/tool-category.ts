import type { ToolCategory } from "./types";

const EDIT_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const AGENT_TOOLS: readonly string[] = ["Agent", "Task"];
/**
 * Tools that only read. A name gets here only when the tool takes no path it writes and
 * the host's own registry agrees (`isReadOnly` in Claude Code 2.1.325); anything that can
 * write stays out, so its unit is UNAVAILABLE instead of judged on partial evidence.
 */
const READONLY_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "LS",
  "NotebookRead",
  "BashOutput",
  "KillShell",
  // Claude Code 2.1.325, read-only registry entries.
  "LSP",
  "CronList",
  "ReadNotifications",
];
/**
 * Tools of the host that run code on an MCP server and therefore follow the MCP rule
 * (ADR 0017): the host's `isReadOnly` says what the tool is meant to do, not what the
 * server's code does. A write by that server is proven only by the Git fence, so these
 * are `MCP` and never `READONLY`; the `mcp__*` prefix is not the only way in.
 */
const MCP_RESOURCE_TOOLS: readonly string[] = [
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
];
/**
 * Tools that drive the session, its tasks or its user interface and never write a file:
 * they carry no path and no command. `Monitor` is not here: it runs a shell command, so it
 * stays `UNKNOWN` (ADR 0014).
 */
const COORDINATION_TOOLS: readonly string[] = [
  "SendMessage",
  "Skill",
  "SubagentHandback",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "ToolSearch",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "ScheduleWakeup",
  "ListAgents",
  // Claude Code 2.1.325, session and interface only.
  "SendUserMessage",
  "PushNotification",
  "ReportFindings",
  "SendFeedback",
  "ProposeGoal",
  "propose_skills",
  "EndConversation",
  "WaitForMcpServers",
  "ShowOnboardingRolePicker",
  "OfferChromeSetup",
];

/** Explicit lists only: a tool that is not named is `UNKNOWN`, never assumed harmless. */
export function categorizeTool(toolName: string): ToolCategory {
  if (toolName.startsWith("mcp__") || MCP_RESOURCE_TOOLS.includes(toolName)) return "MCP";
  if (EDIT_TOOLS.includes(toolName)) return "EDIT";
  if (toolName === "Bash") return "BASH";
  if (toolName === "PowerShell") return "POWERSHELL";
  if (AGENT_TOOLS.includes(toolName)) return "AGENT";
  if (READONLY_TOOLS.includes(toolName)) return "READONLY";
  if (COORDINATION_TOOLS.includes(toolName)) return "COORDINATION";

  return "UNKNOWN";
}
