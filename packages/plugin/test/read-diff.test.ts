import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createNodeDiffReader } from "../src/cli/rules-check/read-diff";

describe("createNodeDiffReader", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-read-diff-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("reads a UTF-8 file", async () => {
    const path = join(directory, "ok.diff");
    await writeFile(path, "+ação\n", "utf8");

    const result = await createNodeDiffReader()({ kind: "FILE", path });

    expect(result).toEqual({ status: "READ", text: "+ação\n" });
  });

  test("refuses invalid UTF-8 instead of replacing bytes", async () => {
    const path = join(directory, "bad.diff");
    await writeFile(path, Buffer.from([0x2b, 0xff, 0xfe, 0x0a]));

    const result = await createNodeDiffReader()({ kind: "FILE", path });

    expect(result).toEqual({ status: "FAILED", reason: "DIFF_NOT_UTF8" });
  });
});
