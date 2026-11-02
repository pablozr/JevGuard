import { describe, expect, test } from "vitest";
import type { RemediationChainEntry } from "../src/index";
import { createRemediationChainLog, resolveRemediationChainsFilePath } from "../src/index";
import { context, FakeHistoryFileSystem } from "./support/history-fakes";

const ENTRY: RemediationChainEntry = {
  host: "claude-code",
  chainId: "claude-code:s:1",
  turnIds: ["claude-code:s:1", "claude-code:s:2"],
  attempts: 2,
  maxAttempts: 2,
  signatures: ["aa", "bb"],
  originIds: ["rule-a", "rule-b"],
  resolvedIds: ["rule-a"],
  remainingIds: ["rule-b"],
  result: "LIMIT",
};

function logWith(fileSystem: FakeHistoryFileSystem) {
  return createRemediationChainLog({
    context: context(),
    fileSystem,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

describe("remediation chain log", () => {
  test("writes one allowlisted line next to reviews.jsonl", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    await logWith(fileSystem).record({
      ...ENTRY,
      diff: "secret diff",
      task: "secret task",
      paths: ["src/a.ts"],
    } as RemediationChainEntry);

    const path = resolveRemediationChainsFilePath(context());
    const text = fileSystem.files.get(path) ?? "";
    const record = JSON.parse(text.trim());

    expect(path.replaceAll("\\", "/").endsWith("jevguard/remediation-chains.jsonl")).toBe(true);
    expect(Object.keys(record).sort()).toEqual(
      [
        "v",
        "at",
        "host",
        "chainId",
        "turnIds",
        "attempts",
        "maxAttempts",
        "signatures",
        "originIds",
        "resolvedIds",
        "remainingIds",
        "result",
      ].sort(),
    );
    expect(record).toMatchObject({ v: 1, at: "2026-01-01T00:00:00.000Z", resolvedIds: ["rule-a"] });
    expect(text).not.toContain("secret");
  });

  test("contains a failing write", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.failAppend = true;

    await expect(logWith(fileSystem).record(ENTRY)).resolves.toBeUndefined();
  });
});
