// Re-export shim — the app factory and its server bootstrap moved to
// api/server.ts in the D3 split. Importers (`@multiremi/api.js`, tests,
// scripts/snapshot-api-routes.ts) keep working unchanged.
export * from "./server.js";
