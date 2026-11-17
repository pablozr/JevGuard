import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "tools/**/*.test.ts"],
    setupFiles: ["./tools/test/vitest-setup.ts"],
    passWithNoTests: true,
  },
});
