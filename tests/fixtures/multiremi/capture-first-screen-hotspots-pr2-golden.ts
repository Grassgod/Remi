import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capturePr2Responses, capturePr2QueryCounts } from "./first-screen-hotspots-pr2-fixture.js";

// Copy this file and its fixture dependencies to main@7bd32800, then run the
// identical command there and on the PR branch. No post-processing is required.
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? join(import.meta.dir, "first-screen-hotspots-pr2-golden.json") : process.argv[outIndex + 1]!;
const golden = process.argv.includes("--dbq") ? await capturePr2QueryCounts() : await capturePr2Responses();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${out}`);
