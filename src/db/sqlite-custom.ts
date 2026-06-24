// re-export shim — moved to src/shared/ in D1 (refactor/dir-redesign). Kept for backward-compat imports.
// Side-effect module: must run setCustomSQLite swap before any Database is created.
import "../shared/db/sqlite-custom.js";
