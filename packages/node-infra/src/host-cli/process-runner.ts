import {
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  spawn,
} from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./types";

const SAFE_ARGUMENT = /^[A-Za-z0-9@/._:=-]+$/;
const MAX_STDOUT_LENGTH = 1024 * 1024;
const WHERE_TIMEOUT_MS = 3_000;

/**
 * Spawns a host command with an allowlisted command and arguments. Binaries are
 * `.cmd` shims on Windows, so a shell is used only there. stderr is discarded.
 */
export function createNodeProcessRunner(): ProcessRunner {
  return { run: runProcess };
}

function isSafe(request: ProcessRequest): boolean {
  return [request.command, ...request.args].every((token) => SAFE_ARGUMENT.test(token));
}

async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (!isSafe(request)) {
    return { kind: "REJECTED_ARGUMENT" };
  }

  const result = await spawnProcess(request);

  if (result.kind === "EXITED" && result.exitCode !== 0 && process.platform === "win32") {
    return (await isOnWindowsPath(request.command)) ? result : { kind: "NOT_FOUND" };
  }

  return result;
}

function isOnWindowsPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const lookup = spawn("where", [command], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      lookup.kill();
      resolve(true);
    }, WHERE_TIMEOUT_MS);

    lookup.on("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
    lookup.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function terminate(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => child.kill());
  } else {
    child.kill();
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * On Windows the allowlisted tokens are joined into one shell command line, so Node
 * never concatenates an argument array under `shell: true` itself (DEP0190).
 */
function spawnHostCommand(request: ProcessRequest): ChildProcessByStdio<null, Readable, Readable> {
  const options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe"> = {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };

  if (process.platform !== "win32") return spawn(request.command, [...request.args], options);

  const commandLine = [request.command, ...request.args].join(" ");

  return spawn(commandLine, { ...options, shell: true });
}

function spawnProcess(request: ProcessRequest): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const decoder = new StringDecoder("utf8");

    function settle(result: ProcessResult): void {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    const child = spawnHostCommand(request);
    const timer = setTimeout(() => {
      terminate(child);
      settle({ kind: "TIMED_OUT" });
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_LENGTH) {
        stdout += decoder.write(chunk).slice(0, MAX_STDOUT_LENGTH - stdout.length);
      }
    });
    child.stderr.resume();
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ENOENT" ? { kind: "NOT_FOUND" } : { kind: "FAILED" });
    });
    child.on("close", (code) => {
      if (code === null) return settle({ kind: "FAILED" });

      stdout += decoder.end();
      settle({ kind: "EXITED", exitCode: code, stdout: stdout.slice(0, MAX_STDOUT_LENGTH) });
    });
  });
}
