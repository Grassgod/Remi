declare const MULTIREMI_VERSION: string | undefined;

const injectedVersion =
  typeof MULTIREMI_VERSION !== "undefined" && MULTIREMI_VERSION
    ? MULTIREMI_VERSION
    : null;

/** Remi version, with release builds taking their value from the Git tag. */
export const VERSION = injectedVersion?.replace(/^v/, "") ?? "0.2.26";
