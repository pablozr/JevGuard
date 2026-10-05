import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { HookDependencies } from "../src/hook";
import { runHook } from "../src/hook";
import { HookWorld, SESSION } from "./hook-world";

let world: HookWorld;

beforeEach(() => {
  world = new HookWorld();
});

afterEach(() => {
  world.cleanup();
});

function stopWith(dependencies: HookDependencies): void {
  const payload = {
    session_id: SESSION,
    cwd: world.projectRoot,
    hook_event_name: "Stop",
    background_tasks: [],
    stop_hook_active: false,
  };

  runHook(JSON.stringify(payload), dependencies);
}

describe("review worker spawn", () => {
  test("a Stop that creates a handoff starts the worker once", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("rewrite a.ts");
    world.edit("src/a.ts", "new\n");

    expect(world.spawns).toBe(0);

    world.stop();

    expect(world.spawns).toBe(1);
  });

  test("an already existing handoff does not start the worker", () => {
    world.prompt("anything");
    stopWith({ ...world.dependencies(), createHandoffSink: () => ({ deliver: () => "EXISTS" }) });

    expect(world.spawns).toBe(0);
  });

  test("a failed handoff write does not start the worker", () => {
    world.prompt("anything");
    stopWith({ ...world.dependencies(), createHandoffSink: () => ({ deliver: () => "FAILED" }) });

    expect(world.spawns).toBe(0);
  });

  test("SessionStart starts the worker to drain older handoffs", () => {
    world.hook({ hook_event_name: "SessionStart", source: "startup" });

    expect(world.spawns).toBe(1);
  });

  test("an ordinary event does not start the worker", () => {
    world.prompt("hello");

    expect(world.spawns).toBe(0);
  });

  test("a missing worker file is logged as a code", () => {
    world.spawnWorker = () => "ENTRY_MISSING";
    world.hook({ hook_event_name: "SessionStart", source: "startup" });

    expect(world.hookLog().map((entry) => entry.code)).toContain("WORKER_ENTRY_MISSING");
  });

  test("a spawn failure is logged as a code and leaves the handoff untouched", () => {
    world.spawnWorker = () => {
      throw new Error("spawn failed with /secret/path");
    };
    world.write("src/a.ts", "old\n");
    world.prompt("rewrite a.ts");
    world.edit("src/a.ts", "new\n");
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
    expect(world.hookLog().map((entry) => entry.code)).toContain("WORKER_SPAWN_FAILED");
    expect(JSON.stringify(world.hookLog())).not.toContain("secret");
  });
});
