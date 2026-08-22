import type {
  MultiremiPlatformDeploymentDriver,
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";

export interface PlatformInspection {
  driver: MultiremiPlatformDeploymentDriver;
  currentRelease: MultiremiPlatformRelease | null;
  recentReleases: MultiremiPlatformRelease[];
  services: MultiremiPlatformService[];
}

export interface PlatformDeploymentDriver {
  readonly kind: MultiremiPlatformDeploymentDriver;
  inspect(): Promise<PlatformInspection>;
  execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
  ): Promise<MultiremiPlatformRelease | null>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<CommandResult>;
}

export class BunCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<CommandResult> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }
}
