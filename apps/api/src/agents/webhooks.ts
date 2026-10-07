import type { Request, Response } from "express";
import { getAnthropic } from "./anthropic.js";
import { onDeploymentRun, onSessionStopped } from "./schedules.js";

// Notifications from the agent runtime (Anthropic -> altship) about scheduled
// runs: one started, or a session stopped. Each carries only an id; what
// happened is read back from the runtime. Optional: without
// ANTHROPIC_WEBHOOK_SIGNING_KEY runs are still picked up when a page that
// shows them is opened, but nothing is emailed.
//
// Registered in the Anthropic Console (Manage -> Webhooks) for the event
// types handled below.

/** Mounted with a raw body parser: the signature covers the exact bytes sent. */
export async function anthropicWebhook(req: Request, res: Response) {
  const key = process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY;
  if (!key) return res.status(503).json({ error: "ANTHROPIC_WEBHOOK_SIGNING_KEY isn't set, so run notifications are off." });

  let event;
  try {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
    event = getAnthropic().beta.webhooks.unwrap(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "", { headers, key });
  } catch {
    return res.status(400).json({ error: "Invalid signature." });
  }

  // The same event can be delivered more than once; each handler is safe to repeat.
  try {
    switch (event.data.type) {
      case "deployment_run.succeeded":
      case "deployment_run.failed":
        await onDeploymentRun(event.data.id);
        break;
      case "session.status_idled":
      case "session.status_terminated":
        await onSessionStopped(event.data.id);
        break;
    }
  } catch (err) {
    // Logged without the payload; a non-2xx asks the runtime to try again.
    console.error("Anthropic webhook failed:", event.data.type, err instanceof Error ? err.message : "unknown error");
    return res.status(500).json({ error: "Couldn't process the event." });
  }
  res.status(204).end();
}
