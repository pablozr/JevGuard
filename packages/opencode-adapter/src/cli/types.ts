export type OpenCodePluginCheckCode =
  | "REGISTERED"
  | "PIN_MISSING"
  | "PIN_MISMATCH"
  | "NOT_REGISTERED"
  | "INSPECTION_FAILED";

/** What the host's plugin cache proves about the registered entries. */
export type OpenCodeRuntimeCheckCode =
  | "RESOLVED"
  | "VERSION_MISMATCH"
  | "DIVERGENT_ENTRIES"
  | "NOT_CACHED"
  | "UNREADABLE"
  | "UNSUPPORTED"
  | "NOT_REGISTERED";
