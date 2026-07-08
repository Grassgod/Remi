/**
 * Types for the imaging module (Gemini-based image generation).
 */

export interface ImageGenerateOptions {
  /** Reference image for editing (optional). */
  referenceImage?: Buffer;
  /** Aspect ratio hint, e.g. "1:1", "16:9", "9:16". */
  aspectRatio?: string;
}

export interface ImageResult {
  /** Raw image data. */
  buffer: Buffer;
  /** MIME type, e.g. "image/png". */
  mimeType: string;
  /** Text description returned by the model (if any). */
  text?: string;
}

/** Gemini generateContent request body. */
export interface GeminiGenerateContentRequest {
  contents: Array<{
    parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    >;
  }>;
  generationConfig?: {
    responseModalities?: string[];
    [key: string]: unknown;
  };
}

/** Gemini generateContent response body. */
export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}
