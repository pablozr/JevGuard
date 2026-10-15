export interface PolicyFileSystem {
  readFile(path: string): Promise<string>;
}

export interface PolicyLoaderDependencies {
  readonly root: string;
  readonly fileSystem: PolicyFileSystem;
}

/** The fixed absolute locations of the two policy files under a project root. */
export interface PolicyFilePaths {
  readonly rules: string;
  readonly config: string;
}
