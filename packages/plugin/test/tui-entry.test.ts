import { describe, expect, test } from "vitest";
import plugin from "../src/tui/index";

/**
 * The OpenCode V1.18.31 loader reads only the TUI module's default export. This
 * guards the packaging-visible identity and the target-exclusive shape so an entry
 * regression fails before an artifact is built.
 */
describe("JevGuard TUI target module", () => {
  test("default-exports the jevguard TUI plugin with no server target", () => {
    expect(plugin.id).toBe("jevguard");
    expect(typeof plugin.tui).toBe("function");
    expect("server" in plugin).toBe(false);
  });
});
