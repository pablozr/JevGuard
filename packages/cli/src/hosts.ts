import { createClaudeCodeCliExtension } from "@jevguard/claude-code-plugin/cli";
import type { HostCliExtension, HostId } from "@jevguard/node-infra";
import { createOpenCodeCliExtension } from "@jevguard/opencode-adapter/cli";

export const DEFAULT_HOST: HostId = "opencode";

const REGISTRY: Readonly<Record<HostId, HostCliExtension>> = {
  opencode: createOpenCodeCliExtension(),
  "claude-code": createClaudeCodeCliExtension(),
};

export const EXTENSIONS: readonly HostCliExtension[] = Object.values(REGISTRY);

export const HOST_IDS: readonly HostId[] = EXTENSIONS.map((extension) => extension.id);

export function isHostId(value: string): value is HostId {
  return Object.hasOwn(REGISTRY, value);
}

export function extensionFor(host: HostId): HostCliExtension {
  return REGISTRY[host];
}
