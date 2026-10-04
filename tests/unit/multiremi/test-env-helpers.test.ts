import { expect, it } from "bun:test";
import { resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

it("restores the preload upload root and preserves it across repeated cleanup", () => {
  const initial = process.env.MULTIREMI_UPLOAD_DIR;
  expect(initial).toBeDefined();
  try {
    expect(useUploadDir()).not.toBe(initial);
    resetMultiremiTestEnv();
    expect(process.env.MULTIREMI_UPLOAD_DIR).toBe(initial);
    resetMultiremiTestEnv();
    expect(process.env.MULTIREMI_UPLOAD_DIR).toBe(initial);
  } finally { resetMultiremiTestEnv(); }
});
