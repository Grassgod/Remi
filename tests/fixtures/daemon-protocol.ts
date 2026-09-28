import { version } from "../../package.json";
import { MultiremiDaemon, type MultiremiDaemonOptions } from "@multiremi/daemon.js";

/** Source tests do not receive the release build's MULTIREMI_VERSION define. */
export class TestMultiremiDaemon extends MultiremiDaemon {
  constructor(options: MultiremiDaemonOptions) {
    super({
      ...options,
      protocolClientOptions: { cliVersion: version, ...options.protocolClientOptions },
    });
  }
}
