declare const MULTIREMI_VERSION: string | undefined;

const compiledVersion =
  typeof MULTIREMI_VERSION !== "undefined" && MULTIREMI_VERSION
    ? MULTIREMI_VERSION
    : null;
const runtimeVersion =
  typeof process !== "undefined" ? process.env.MULTIREMI_VERSION?.trim() || null : null;
const injectedVersion = compiledVersion ?? runtimeVersion;

/** Remi version, with release builds taking their value from the Git tag. */
export const VERSION = injectedVersion?.replace(/^v/, "") ?? "0.2.26";
