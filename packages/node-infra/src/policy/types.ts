export interface PolicyFileSystem {
  readFile(path: string): Promise<string>;
}

export interface PolicyLoaderDependencies {
  readonly root: string;
  readonly fileSystem: PolicyFileSystem;
}
