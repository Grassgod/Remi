import { VERSION } from "@shared/version.js";

/**
 * Identifies this CLI on every request it makes.
 *
 * The repository Wiki list route uses it to separate an upgraded CLI from the
 * `Bun/<version>` User-Agent that older daemons send, which the platform still
 * answers with the pre-MUL-387 full-body response. See
 * docs/adr/0002-repository-wiki-list-without-bodies.md.
 */
export function remiCliUserAgent(): string {
  return `remi-cli/${VERSION}`;
}
