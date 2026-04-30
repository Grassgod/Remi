/**
 * Low-level Gemini API client for image generation.
 * Uses native fetch — Bun respects HTTP_PROXY/HTTPS_PROXY env vars.
 */

import { createLogger } from "../logger.js";
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  ImageResult,
} from "./types.js";

const log = createLogger("imaging");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_RETRIES = 1;

export interface GeminiClientOptions {
  apiKey: string;
  model: string;
}

/**
 * Call Gemini generateContent API to produce an image.
 * Returns the first image found in the response candidates.
 */
export async function geminiGenerateImage(
  prompt: string,
  options: GeminiClientOptions & {
    referenceImage?: Buffer;
    referenceImageMimeType?: string;
  },
): Promise<ImageResult> {
  const { apiKey, model, referenceImage, referenceImageMimeType } = options;

  const parts: GeminiGenerateContentRequest["contents"][0]["parts"] = [];

  // If a reference image is provided, include it first
  if (referenceImage) {
    parts.push({
      inlineData: {
        mimeType: referenceImageMimeType ?? "image/png",
        data: referenceImage.toString("base64"),
      },
    });
  }

  parts.push({ text: prompt });

  const requestBody: GeminiGenerateContentRequest = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.debug(`Gemini image request (attempt ${attempt + 1})`, { model, promptLength: prompt.length });

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (attempt < MAX_RETRIES && res.status >= 500) continue;
        throw new Error(`Gemini API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as GeminiGenerateContentResponse;

      if (data.error) {
        throw new Error(`Gemini API error: ${data.error.message} (${data.error.status})`);
      }

      // Extract image and text from response
      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts) {
        throw new Error("Gemini API returned no candidates");
      }

      let imageBuffer: Buffer | null = null;
      let mimeType = "image/png";
      let text: string | undefined;

      for (const part of candidate.content.parts) {
        if (part.inlineData) {
          imageBuffer = Buffer.from(part.inlineData.data, "base64");
          mimeType = part.inlineData.mimeType;
        }
        if (part.text) {
          text = part.text;
        }
      }

      if (!imageBuffer) {
        throw new Error("Gemini API returned no image data");
      }

      log.info("Image generated", { model, size: imageBuffer.length, mimeType });

      return { buffer: imageBuffer, mimeType, text };
    } catch (err) {
      if (attempt < MAX_RETRIES) continue;
      throw err;
    }
  }

  // Unreachable, but TypeScript wants it
  throw new Error("Gemini image generation failed after retries");
}
