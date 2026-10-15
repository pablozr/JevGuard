import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "../src/index";

const FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const SECOND_DIFF = [
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "",
].join("\n");

function invalid(reason: string) {
  return { status: "INVALID", reason };
}

function paths(text: string): readonly string[] {
  const result = parseUnifiedDiff(text);

  return result.status === "PARSED" ? result.files.map((file) => file.path) : [];
}

describe("parseUnifiedDiff", () => {
  test("splits a two-file git diff into literal per-file patches", () => {
    expect(parseUnifiedDiff(FILE_DIFF + SECOND_DIFF)).toEqual({
      status: "PARSED",
      files: [
        { path: "src/a.ts", patch: FILE_DIFF },
        { path: "src/b.ts", patch: SECOND_DIFF },
      ],
    });
  });

  test("never puts another file's lines into a patch", () => {
    const result = parseUnifiedDiff(FILE_DIFF + SECOND_DIFF);

    if (result.status !== "PARSED") {
      throw new Error("expected PARSED");
    }

    expect(result.files[0]?.patch).not.toContain("src/b.ts");
    expect(result.files[1]?.patch).not.toContain("src/a.ts");
  });

  test.each(["", "   \n\n"])("treats empty input %j as no files", (text) => {
    expect(parseUnifiedDiff(text)).toEqual({ status: "PARSED", files: [] });
  });

  test("accepts leading blank lines and trailing blank lines", () => {
    expect(paths(`\n\n${FILE_DIFF}\n\n`)).toEqual(["src/a.ts"]);
  });

  test("keeps a patch without a final newline unchanged", () => {
    const diff = FILE_DIFF.slice(0, -1);

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "src/a.ts", patch: diff }],
    });
  });

  test("uses the new path for a created file", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+a",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "src/new.ts", patch: diff }],
    });
  });

  test("uses the old path for a deleted file", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-a",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "src/gone.ts", patch: diff }],
    });
  });

  test("keeps CRLF in the patch and strips it from classification", () => {
    const diff = FILE_DIFF.replaceAll("\n", "\r\n");

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "src/a.ts", patch: diff }],
    });
  });

  test("accepts a no-newline marker after either side", () => {
    const diff = FILE_DIFF.replace(
      "-old\n+new\n",
      "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    );

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "src/a.ts", patch: diff }],
    });
  });

  test("handles several hunks and a hunk header with a function context", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@ function one()",
      " keep",
      "-a",
      "+b",
      "@@ -10 +10,2 @@",
      " ctx",
      "+added",
      "",
    ].join("\n");

    expect(paths(diff)).toEqual(["src/a.ts"]);
  });

  test("treats an empty line inside a hunk as an empty context line", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "",
      "-b",
      "+c",
      "",
    ].join("\n");

    expect(paths(diff)).toEqual(["src/a.ts"]);
  });

  test("cuts a tab-separated timestamp suffix from the path", () => {
    const diff = [
      "--- a/src/a.ts\t2026-01-01 00:00:00",
      "+++ b/src/a.ts\t2026-01-01 00:00:01",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    expect(paths(diff)).toEqual(["src/a.ts"]);
  });

  test("accepts the plain ---/+++ format with a/ b/ prefixes or none", () => {
    const prefixed = ["--- a/one.ts", "+++ b/one.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const bare = ["--- two.ts", "+++ two.ts", "@@ -1 +1 @@", "-c", "+d", ""].join("\n");

    expect(paths(prefixed + bare)).toEqual(["one.ts", "two.ts"]);
  });

  test("ignores a pure rename and a mode change without content", () => {
    const rename = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const mode = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join(
      "\n",
    );

    expect(parseUnifiedDiff(rename + mode + SECOND_DIFF)).toEqual({
      status: "PARSED",
      files: [{ path: "src/b.ts", patch: SECOND_DIFF }],
    });
  });

  test("treats removed '-- x' and added '++ y' lines as hunk content in git mode", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "--- x",
      "+++ y",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "src/a.ts", patch: diff }],
    });
  });

  test("treats removed '-- x' and added '++ y' lines as hunk content in plain mode", () => {
    const diff = ["--- a/s.ts", "+++ b/s.ts", "@@ -1 +1 @@", "--- x", "+++ y", ""].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual({
      status: "PARSED",
      files: [{ path: "s.ts", patch: diff }],
    });
  });

  test("starts a new plain section after a complete hunk", () => {
    const first = ["--- a/one.ts", "+++ b/one.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const second = ["--- a/two.ts", "+++ b/two.ts", "@@ -1 +1 @@", "-c", "+d", ""].join("\n");

    expect(paths(first + second)).toEqual(["one.ts", "two.ts"]);
  });

  test("rejects unrecognizable text", () => {
    expect(parseUnifiedDiff("hello world\nnot a diff\n")).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects a combined diff anywhere", () => {
    const combined = "diff --cc src/a.ts\nindex 1,2..3\n--- a/src/a.ts\n+++ b/src/a.ts\n";

    expect(parseUnifiedDiff(combined)).toEqual(invalid("COMBINED_DIFF"));
    expect(parseUnifiedDiff(FILE_DIFF + combined)).toEqual(invalid("COMBINED_DIFF"));
    expect(parseUnifiedDiff("diff --combined x\n")).toEqual(invalid("COMBINED_DIFF"));
  });

  test("rejects git log -p and format-patch preambles", () => {
    const logPatch = `commit abc123\nAuthor: A <a@b.c>\n\n    message\n\n${FILE_DIFF}`;
    const formatPatch = `From: a@b.c\nSubject: [PATCH] x\n\n---\n a | 1 +\n\n${FILE_DIFF}`;

    expect(parseUnifiedDiff(logPatch)).toEqual(invalid("UNRECOGNIZED_DIFF"));
    expect(parseUnifiedDiff(formatPatch)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects a format-patch signature after the last hunk", () => {
    expect(parseUnifiedDiff(`${FILE_DIFF}-- \n2.40.0\n`)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects garbage after a complete hunk", () => {
    expect(parseUnifiedDiff(`${FILE_DIFF}garbage\n`)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects a plain section appended after a git section", () => {
    const plain = ["--- a/c.ts", "+++ b/c.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");

    expect(parseUnifiedDiff(FILE_DIFF + plain)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects a hunk with more lines than its counts", () => {
    expect(parseUnifiedDiff(`${FILE_DIFF}+extra\n`)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects a malformed hunk header", () => {
    const diff = FILE_DIFF.replace("@@ -1 +1 @@", "@@ -x +1 @@");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects a diff truncated inside a hunk", () => {
    const truncated = FILE_DIFF.replace("@@ -1 +1 @@", "@@ -1,3 +1,3 @@");

    expect(parseUnifiedDiff(truncated)).toEqual(invalid("TRUNCATED_HUNK"));
  });

  test("rejects a content header without any hunk", () => {
    const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n";

    expect(parseUnifiedDiff(diff)).toEqual(invalid("TRUNCATED_HUNK"));
  });

  test("rejects a git section with a hunk but no ---/+++ headers", () => {
    const diff = "diff --git a/x.ts b/x.ts\nindex 1..2 100644\n@@ -1 +1 @@\n-a\n+b\n";

    expect(parseUnifiedDiff(diff)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects an unknown extended header", () => {
    const diff = FILE_DIFF.replace("index 1111111..2222222 100644", "mystery header");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test("rejects ---/+++ paths that disagree with the diff --git header", () => {
    const old = FILE_DIFF.replace("--- a/src/a.ts", "--- a/src/other.ts");
    const next = FILE_DIFF.replace("+++ b/src/a.ts", "+++ b/src/other.ts");

    expect(parseUnifiedDiff(old)).toEqual(invalid("UNRECOGNIZED_DIFF"));
    expect(parseUnifiedDiff(next)).toEqual(invalid("UNRECOGNIZED_DIFF"));
  });

  test.each([
    ["a binary files marker", "Binary files a/x.png and b/x.png differ\n"],
    ["a git binary patch", "GIT binary patch\nliteral 3\nabc\n"],
  ])("rejects %s", (_name, body) => {
    const diff = `${FILE_DIFF}diff --git a/x.png b/x.png\nindex 1..2\n${body}`;

    expect(parseUnifiedDiff(diff)).toEqual(invalid("BINARY_PATCH"));
  });

  test("rejects quoted paths in the header and in ---/+++", () => {
    const header = 'diff --git "a/sp ace.ts" "b/sp ace.ts"\n';
    const lines = '--- "a/sp ace.ts"\n+++ "b/sp ace.ts"\n@@ -1 +1 @@\n-a\n+b\n';
    const plain = ['--- "a/sp ace.ts"', '+++ "b/sp ace.ts"', "@@ -1 +1 @@", "-a", "+b", ""];

    expect(parseUnifiedDiff(header + lines)).toEqual(invalid("QUOTED_PATH"));
    expect(parseUnifiedDiff(plain.join("\n"))).toEqual(invalid("QUOTED_PATH"));
  });

  test("rejects a plain section whose both paths are /dev/null", () => {
    const diff = ["--- /dev/null", "+++ /dev/null", "@@ -0,0 +0,0 @@", ""].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("MISSING_PATH"));
  });

  test("rejects an empty path", () => {
    const diff = ["--- a/", "+++ b/", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("MISSING_PATH"));
  });

  test("rejects a rename with content, so .env content never travels under another path", () => {
    const diff = [
      "diff --git a/.env b/src/env.ts",
      "similarity index 60%",
      "rename from .env",
      "rename to src/env.ts",
      "--- a/.env",
      "+++ b/src/env.ts",
      "@@ -1 +1 @@",
      "-KEY=1",
      "+KEY=2",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("RENAMED_PATH"));
  });

  test("rejects a plain diff whose two paths differ", () => {
    const diff = ["--- a/.env", "+++ b/src/env.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("RENAMED_PATH"));
  });

  test.each([
    ["mnemonic", "i/", "w/"],
    ["no prefix", "", ""],
    ["custom", "x/", "y/"],
  ])("rejects git-mode %s prefixes", (_name, oldPrefix, newPrefix) => {
    const diff = [
      `diff --git ${oldPrefix}src/a.ts ${newPrefix}src/a.ts`,
      `--- ${oldPrefix}src/a.ts`,
      `+++ ${newPrefix}src/a.ts`,
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("UNSUPPORTED_PREFIX"));
  });

  test("rejects a git-mode ---/+++ pair with the wrong prefix under an a/ b/ header", () => {
    const diff = FILE_DIFF.replace("+++ b/src/a.ts", "+++ w/src/a.ts");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("UNSUPPORTED_PREFIX"));
  });

  test("rejects mixed plain prefixes", () => {
    const diff = ["--- a/one.ts", "+++ one.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual(invalid("UNSUPPORTED_PREFIX"));
  });
});
