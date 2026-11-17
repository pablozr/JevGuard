import { afterEach } from "vitest";
import { installHermeticGitEnv } from "./hermetic-git";

// Every Git process the suite spawns, directly or through the code under test,
// must use an isolated configuration: the machine's global hooks are not ours.
// The support directory this creates is per worker, inside the run directory that
// `global-setup.ts` removes in its teardown, so a run leaves nothing behind in the
// system temp directory.
installHermeticGitEnv();

// Captured before any test can install fake timers, so a yield always schedules a
// real macrotask.
const yieldToEventLoop = globalThis.setImmediate;

/**
 * Give the worker one full event-loop turn after every test.
 *
 * Vitest's worker calls `onTaskUpdate` over its RPC channel and rejects it after 60 s
 * (birpc's default). A file that runs long synchronous Git work keeps the worker in
 * microtasks only, so neither the timer phase nor the message that carries the answer
 * runs; when the file finally yields, the expired timer fires before the queued
 * message and the run exits 1 with `Timeout calling "onTaskUpdate"`, though every test
 * passed. One macrotask per test bounds that starvation to a single test.
 */
afterEach(async () => {
  await new Promise<void>((resolve) => {
    yieldToEventLoop(resolve);
  });
});
