import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readBlockedUnit, recordBlockedUnit } from "../src/capture/unit-state";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jevguard-blocked-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the per-unit block marker", () => {
  test("a session with no marker reads as none", () => {
    expect(readBlockedUnit(directory)).toBeNull();
  });

  test("records the unit as epoch:ordinal, with no content", () => {
    recordBlockedUnit({ sessionDirectory: directory, epoch: "0123456789abcdef", ordinal: 7 });

    expect(readBlockedUnit(directory)).toBe("0123456789abcdef:7");
    expect(readFileSync(join(directory, "blocked"), "utf8")).toBe("0123456789abcdef:7");
  });

  test("a later block of the next unit replaces the marker", () => {
    recordBlockedUnit({ sessionDirectory: directory, epoch: "0123456789abcdef", ordinal: 7 });
    recordBlockedUnit({ sessionDirectory: directory, epoch: "0123456789abcdef", ordinal: 8 });

    expect(readBlockedUnit(directory)).toBe("0123456789abcdef:8");
  });

  test("a damaged marker reads as none, never as a block", () => {
    writeFileSync(join(directory, "blocked"), "not a unit");

    expect(readBlockedUnit(directory)).toBeNull();
  });

  test("a directory that vanished is none, not an error", () => {
    expect(readBlockedUnit(join(directory, "gone"))).toBeNull();
  });
});
