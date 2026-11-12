import { type FileImage, toTurn } from "@jevguard/claude-code-adapter";
import { normalizeFileDiff } from "@jevguard/opencode-adapter";
import { describe, expect, test } from "vitest";

interface ParityCase {
  readonly name: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

function numbered(count: number, replacements: Readonly<Record<number, string>> = {}): string {
  const rows = Array.from({ length: count }, (_, index) => replacements[index] ?? `line ${index}`);

  return `${rows.join("\n")}\n`;
}

function image(content: string): FileImage {
  return content === ""
    ? { state: "ABSENT" }
    : { state: "PRESENT", digest: `d:${content}`, content };
}

function claudePatch(testCase: ParityCase): string | undefined {
  const { path, before, after } = testCase;
  const unit = {
    sessionId: "s",
    ordinal: 0,
    prompts: ["t"],
    files: [{ path, before: image(before), after: image(after) }],
  };

  return toTurn(unit).files[0]?.patch;
}

function opencodePatch(testCase: ParityCase): string | undefined {
  const { path, before, after } = testCase;
  const result = normalizeFileDiff({ file: path, before, after });

  return result.status === "PATCH" ? result.file.patch : undefined;
}

const CASES: readonly ParityCase[] = [
  {
    name: "one changed line in a large file",
    path: "src/big.ts",
    before: numbered(300),
    after: numbered(300, { 150: "changed" }),
  },
  {
    name: "two distant changes",
    path: "src/a.ts",
    before: numbered(120),
    after: numbered(120, { 5: "changed five", 110: "changed one-ten" }),
  },
  {
    name: "no final newline on both sides",
    path: "src/n.ts",
    before: "a\nb",
    after: "a\nc",
  },
  {
    name: "no final newline on the old side only",
    path: "src/old.ts",
    before: "a\nb",
    after: "a\nb\nc\n",
  },
  {
    name: "no final newline on the new side only",
    path: "src/new.ts",
    before: "a\nb\n",
    after: "a\nb\nc",
  },
  { name: "created file", path: "src/created.ts", before: "", after: "x\ny\n" },
  { name: "deleted file", path: "src/deleted.ts", before: "x\ny\n", after: "" },
  {
    name: "CRLF line endings",
    path: "src/crlf.ts",
    before: "a\r\nb\r\nc\r\n",
    after: "a\r\nB\r\nc\r\n",
  },
  {
    name: "path with a space",
    path: "src/my file.ts",
    before: "one\ntwo\n",
    after: "one\n2\n",
  },
];

describe("OpenCode and Claude Code build the same evidence patch", () => {
  test.each(CASES)("$name", (testCase) => {
    const patch = opencodePatch(testCase);

    expect(patch).toBeDefined();
    expect(patch).toBe(claudePatch(testCase));
  });
});
