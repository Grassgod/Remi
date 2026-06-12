/**
 * Blob storage abstraction for attachments. The Go server uses S3 (presigned
 * URLs); the Bun self-host default is a local-filesystem store (no external
 * dependency). Any backend implements this interface; the route is storage-
 * agnostic. URLs are opaque storage handles — `keyFromUrl` reverses `upload`.
 */

export interface StoredBlob {
  data: Uint8Array;
  contentType: string;
  filename: string;
}

export interface Storage {
  /** Persist `data` under `key`; returns the storage URL stored on the row. */
  upload(key: string, data: Uint8Array, contentType: string, filename: string): Promise<string>;
  /** Read a blob by storage key; null when absent. */
  read(key: string): Promise<StoredBlob | null>;
  /** Recover the storage key from a stored URL (inverse of upload's return). */
  keyFromUrl(url: string): string;
}
