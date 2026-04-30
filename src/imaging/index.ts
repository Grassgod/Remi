/**
 * Imaging module — high-level image generation interface.
 *
 * Usage:
 *   import { initImaging, generateImage } from "./imaging/index.js";
 *   initImaging(config.google);
 *   const result = await generateImage("a cat wearing sunglasses");
 *   // result.buffer — raw PNG/JPEG Buffer
 *   // result.mimeType — "image/png" etc.
 */

import type { GoogleConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { geminiGenerateImage } from "./gemini-client.js";
import type { ImageGenerateOptions, ImageResult } from "./types.js";

export type { ImageGenerateOptions, ImageResult } from "./types.js";

const log = createLogger("imaging");

let _config: GoogleConfig | null = null;

/**
 * Initialize the imaging module with Google API config.
 * Returns true if successfully initialized, false if no config/key.
 */
export function initImaging(config?: GoogleConfig): boolean {
  if (!config?.apiKey) {
    log.warn("Imaging module not initialized: no Google API key");
    return false;
  }
  _config = config;
  log.info("Imaging module initialized", { model: config.model });
  return true;
}

/** Check if imaging is available. */
export function isImagingEnabled(): boolean {
  return _config !== null;
}

/**
 * Generate an image from a text prompt.
 * Throws if imaging is not initialized.
 */
export async function generateImage(
  prompt: string,
  options?: ImageGenerateOptions,
): Promise<ImageResult> {
  if (!_config) {
    throw new Error("Imaging module not initialized — call initImaging() first");
  }

  let fullPrompt = prompt;
  if (options?.aspectRatio) {
    fullPrompt += `\n\nAspect ratio: ${options.aspectRatio}`;
  }

  return geminiGenerateImage(fullPrompt, {
    apiKey: _config.apiKey,
    model: _config.model,
    referenceImage: options?.referenceImage,
  });
}
