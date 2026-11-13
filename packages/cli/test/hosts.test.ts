import { describe, expect, test } from "vitest";
import { DEFAULT_HOST, extensionFor, HOST_IDS, isHostId } from "../src/hosts";

describe("host registry", () => {
  test("registers OpenCode and Claude Code, with OpenCode as the default", () => {
    expect(HOST_IDS).toEqual(["opencode", "claude-code"]);
    expect(DEFAULT_HOST).toBe("opencode");
  });

  test("resolves each registered host to its own extension", () => {
    for (const id of HOST_IDS) {
      expect(extensionFor(id).id).toBe(id);
    }
  });

  test("recognises only registered host ids", () => {
    expect(isHostId("claude-code")).toBe(true);
    expect(isHostId("cursor")).toBe(false);
  });
});
