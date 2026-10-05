import type { ToolCategory } from "./types";

const EDIT_TOOLS: readonly string[] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const AGENT_TOOLS: readonly string[] = ["Agent", "Task"];
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
];
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
  "Monitor",
];

/** Explicit lists only: a tool that is not named is `UNKNOWN`, never assumed harmless. */
export function categorizeTool(toolName: string): ToolCategory {
  if (toolName.startsWith("mcp__")) return "MCP";
  if (EDIT_TOOLS.includes(toolName)) return "EDIT";
  if (toolName === "Bash") return "BASH";
  if (toolName === "PowerShell") return "POWERSHELL";
  if (AGENT_TOOLS.includes(toolName)) return "AGENT";
  if (READONLY_TOOLS.includes(toolName)) return "READONLY";
  if (COORDINATION_TOOLS.includes(toolName)) return "COORDINATION";

  return "UNKNOWN";
}
