import { spawn } from "node:child_process";
import { checkAbort } from "./errors.js";

export interface ProcessResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}
export async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    killGraceMs?: number;
    limit?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProcessResult> {
  checkAbort(options.signal);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      shell: false,
      detached: processGroup,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    let error: unknown;
    let failed = false;
    let cleanup: Promise<void> | undefined;
    const send = (signal: NodeJS.Signals | 0) => {
      if (!child.pid) return false;
      try {
        if (processGroup) process.kill(-child.pid, signal);
        else if (signal === 0)
          return child.exitCode === null && child.signalCode === null;
        else child.kill(signal);
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw cause;
      }
    };
    const recordFailure = (cause: unknown) => {
      if (!failed) {
        error = cause;
        failed = true;
      }
    };
    // Each tool owns a process group. Give it time to close its browser before
    // force-stopping remaining descendants, including ones holding stdout open.
    const stop = () => {
      if (cleanup) return;
      clearTimeout(timer);
      cleanup = new Promise<void>((done) => {
        let force: NodeJS.Timeout | undefined;
        let poll: NodeJS.Timeout | undefined;
        const finish = () => {
          clearTimeout(force);
          clearInterval(poll);
          done();
        };
        const signal = (value: NodeJS.Signals | 0) => {
          try {
            return send(value);
          } catch (cause) {
            recordFailure(
              Object.assign(
                new Error(`Could not stop tool: ${command}`, { cause }),
                { code: "ENVIRONMENT_ERROR" },
              ),
            );
            return false;
          }
        };
        if (!signal("SIGTERM")) {
          finish();
          return;
        }
        force = setTimeout(() => {
          signal("SIGKILL");
          finish();
        }, options.killGraceMs ?? 5000);
        poll = setInterval(() => {
          if (!signal(0)) finish();
        }, 20);
      });
    };
    const timer = setTimeout(() => {
      recordFailure(
        Object.assign(new Error(`Process timed out: ${command}`), {
          code: "TOOL_TIMEOUT",
        }),
      );
      stop();
    }, options.timeout ?? 120000);
    const onAbort = () => {
      recordFailure(options.signal!.reason);
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > (options.limit ?? 16 * 1024 * 1024)) {
        recordFailure(
          Object.assign(new Error(`Output limit exceeded: ${command}`), {
            code: "TOOL_OUTPUT_LIMIT",
          }),
        );
        stop();
      } else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (err) => {
      recordFailure(Object.assign(err, { code: "ENVIRONMENT_ERROR" }));
      stop();
    });
    child.on("exit", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      void Promise.resolve(cleanup)
        .then(() => {
          options.signal?.removeEventListener("abort", onAbort);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve AbortSignal.reason, including non-Error reasons.
          if (failed) reject(error);
          else
            resolve({
              command,
              args,
              stdout: Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
              exitCode: code ?? -1,
              durationMs: Date.now() - started,
            });
        })
        .catch(reject);
    });
    if (options.signal?.aborted) onAbort();
  });
}
