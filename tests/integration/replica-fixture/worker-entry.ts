/**
 * The replica Worker's entry point, for the Playwright check.
 *
 * `frontend/packages/core/replica/worker.ts` exports `installReplicaWorkerScope`
 * rather than calling it at module scope, so a unit test can import the worker
 * without installing handlers on a `self` that is not a Worker. This is the three
 * lines that make it a Worker.
 */
import { installReplicaWorkerScope } from "../../../frontend/packages/core/replica/worker";

installReplicaWorkerScope();
