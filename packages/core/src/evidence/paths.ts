export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function pathSegments(path: string): readonly string[] {
  return normalizePath(path)
    .split("/")
    .filter((segment) => segment !== "");
}

export function pathBasename(path: string): string {
  const segments = pathSegments(path);

  return segments[segments.length - 1] ?? "";
}

export function fileExtension(path: string): string {
  const basename = pathBasename(path).toLowerCase();
  const dot = basename.lastIndexOf(".");

  return dot <= 0 ? "" : basename.slice(dot);
}
