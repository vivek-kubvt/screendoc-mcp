/**
 * Small process-exec helper with a timeout and combined output — used to drive
 * maestro, xcrun, adb, and headless Chrome.
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function run(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { cwd, timeoutMs = 120_000, env } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  const res = await run("which", [cmd], { timeoutMs: 5000 });
  return res.code === 0 && res.stdout.trim().length > 0;
}
