import { describe, expect, test } from "vitest";
import { createConfirmationPrompt } from "../src";

describe("node confirmation prompt", () => {
  test("refuses off a TTY", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const result = await createConfirmationPrompt().confirm("Proceed?");

      expect(result).toEqual({ status: "FAILED", reason: "NOT_A_TTY" });
    } finally {
      if (original !== undefined) {
        Object.defineProperty(process.stdin, "isTTY", original);
      }
    }
  });
});
