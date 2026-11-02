import type { ProjectProbe } from "@jevguard/node-infra";
import type { CaptureFileReader } from "../../capture/types";

export { isInsidePath, isInsideProject, parentOf, realPathOfNearest } from "@jevguard/node-infra";

const GIT_MARKER = ".git";

export function projectProbeOf(reader: CaptureFileReader): ProjectProbe {
  return {
    realPath: (path) => reader.realPath(path),
    hasGitMarker: (directory) => reader.stat(`${directory}/${GIT_MARKER}`) !== null,
  };
}
