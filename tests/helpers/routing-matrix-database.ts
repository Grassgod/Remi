import { createReusableStoreDatabase } from "./reusable-store-database.js";

/** Placement-only entrypoint: no schema changes, subscriptions or background work. */
export function createRoutingMatrixDatabase(dialect: "sqlite" | "postgres", postgresUrl?: string) {
  return createReusableStoreDatabase(dialect, postgresUrl, {
    fixture: "placement-invariant-matrix", label: "Routing matrix", strictStoreState: true,
  });
}
