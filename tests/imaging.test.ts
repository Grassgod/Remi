/**
 * Integration test for imaging module (Gemini Nano Banana 2).
 * Requires a valid Google API key in ~/.remi/remi.toml [google] section.
 *
 * Run: bun test tests/imaging.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { loadConfig } from "../src/config.js";
import { initImaging, isImagingEnabled, generateImage } from "../src/imaging/index.js";

describe("Imaging Module", () => {
  beforeAll(() => {
    const config = loadConfig();
    if (config.google) {
      initImaging(config.google);
    }
  });

  it("should initialize with valid config", () => {
    expect(isImagingEnabled()).toBe(true);
  });

  it("should generate an image from text prompt", async () => {
    if (!isImagingEnabled()) {
      console.warn("Skipping: no Google API key configured");
      return;
    }

    const result = await generateImage("A simple red circle on a white background");

    // Verify we got a valid image back
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(100);
    expect(result.mimeType).toMatch(/^image\//);

    // Check it's actually valid image data (PNG or JPEG magic bytes)
    const isPng = result.buffer[0] === 0x89 && result.buffer[1] === 0x50; // PNG: 89 50
    const isJpeg = result.buffer[0] === 0xff && result.buffer[1] === 0xd8; // JPEG: FF D8
    const isWebp = result.buffer.slice(8, 12).toString() === "WEBP";
    expect(isPng || isJpeg || isWebp).toBe(true);

    console.log(`Generated image: ${result.mimeType}, ${result.buffer.length} bytes`);
    if (result.text) {
      console.log(`Model text: ${result.text}`);
    }
  }, 30_000); // 30s timeout for API call
});
