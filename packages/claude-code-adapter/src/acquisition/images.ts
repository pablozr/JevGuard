import type { FileImage, PostImage } from "./types";

export function toPostImage(image: FileImage): PostImage {
  return image.state === "ABSENT" ? image : { state: "PRESENT", digest: image.digest };
}

export function sameImage(final: FileImage, attributed: PostImage): boolean {
  if (final.state === "ABSENT") return attributed.state === "ABSENT";

  return attributed.state === "PRESENT" && attributed.digest === final.digest;
}
