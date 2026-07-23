/**
 * Live progress for long-running tools (create_document, update_document,
 * run_flow). These walk a UI screen-by-screen and can take minutes, so we stream
 * MCP `notifications/progress` back to the client whenever it asked for them (it
 * passes a `progressToken` in the request `_meta`). Every step is also mirrored
 * to stderr so progress is visible in the server log even without a token.
 *
 * If the client didn't request progress, the notification is skipped but stderr
 * logging still happens — the reporter is always safe to call.
 */
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Report one progress step. `progress`/`total` are step counts; `message` is the human line. */
export type ProgressReporter = (progress: number, total: number, message: string) => void;

/**
 * Build a reporter bound to this tool call. Returns a fire-and-forget function
 * (notifications are dispatched but not awaited, so a slow client never stalls
 * the capture loop). No-ops the network side when no progressToken was supplied.
 */
export function makeProgress(extra: ToolExtra | undefined, label: string): ProgressReporter {
  const token = extra?._meta?.progressToken;
  return (progress, total, message) => {
    const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
    // Always log to stderr (stdout is the MCP protocol channel — never touch it).
    process.stderr.write(`[${label}] ${pct}% (${progress}/${total}) ${message}\n`);
    if (token === undefined || !extra) return;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      })
      .catch(() => {
        /* progress is best-effort; a failed notification must never break capture */
      });
  };
}
