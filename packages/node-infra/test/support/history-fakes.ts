import type { ReviewHistoryFileSystem } from "../../src/index";

export class FakeHistoryFileSystem implements ReviewHistoryFileSystem {
  readonly files = new Map<string, string>();
  readonly ensuredDirectories: string[] = [];
  readonly atomicWrites: string[] = [];
  failRead = false;
  failAppend = false;

  async readFile(path: string): Promise<string | null> {
    if (this.failRead) {
      throw new Error("read failed");
    }

    return this.files.get(path) ?? null;
  }

  async appendFile(path: string, data: string): Promise<void> {
    if (this.failAppend) {
      throw new Error("append failed");
    }

    this.files.set(path, (this.files.get(path) ?? "") + data);
  }

  async sizeOf(path: string): Promise<number | null> {
    const contents = this.files.get(path);

    return contents === undefined ? null : Buffer.byteLength(contents, "utf8");
  }

  async writeFileAtomic(path: string, data: string): Promise<void> {
    this.atomicWrites.push(path);
    this.files.set(path, data);
  }

  async ensureParentDirectory(path: string): Promise<void> {
    this.ensuredDirectories.push(path);
  }
}

export function context(
  overrides: { readonly xdg?: string | undefined; readonly homedir?: string } = {},
) {
  return {
    cwd: "C:/work",
    homedir: overrides.homedir ?? "C:/home",
    environment: {
      get: (name: string): string | undefined =>
        name === "XDG_DATA_HOME" ? overrides.xdg : undefined,
    },
  };
}
