import type { CredentialEnvironment } from "./types";

export function createProcessEnvironment(): CredentialEnvironment {
  return {
    get(name: string): string | undefined {
      return process.env[name];
    },
  };
}
