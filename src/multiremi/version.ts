import { VERSION } from "../version.js";

declare const MULTIREMI_VERSION: string | undefined;

export const multiremiVersion =
  typeof MULTIREMI_VERSION !== "undefined" && MULTIREMI_VERSION
    ? MULTIREMI_VERSION
    : VERSION;
