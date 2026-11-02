import { describe, expect, test } from "vitest";
import { createNullSessionNavigator } from "../src/index";

describe("createNullSessionNavigator", () => {
  test("is a no-op on the 2.2.x server plugin and reports DELIVERED", async () => {
    await expect(createNullSessionNavigator().navigate("ses_child")).resolves.toBe("DELIVERED");
  });
});
