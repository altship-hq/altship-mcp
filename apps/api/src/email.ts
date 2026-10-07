// Emails (invites to a server, news of a scheduled agent run), sent through
// Resend's HTTP API. Optional: without RESEND_API_KEY and INVITE_FROM_EMAIL
// nothing is sent; an owner shares an invite link themselves, and runs are
// only shown in the dashboard.
//
//   RESEND_API_KEY     Resend API key
//   INVITE_FROM_EMAIL  verified sender for every email: an address, or "Name <address>" to
//                      choose the name shown (defaults to "altship")
//   DASHBOARD_URL      where invite links point, e.g. https://pilot.altship.io
//                      (defaults to the first ALLOWED_ORIGINS entry)

/** Where the dashboard is served, without a trailing slash. */
export function dashboardUrl(): string {
  const url = process.env.DASHBOARD_URL ?? (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",")[0];
  return url.trim().replace(/\/$/, "");
}

/** Who emails come from, always with a display name: a bare address would show in inboxes as its local part ("hello"). */
function sender(): string | null {
  const from = process.env.INVITE_FROM_EMAIL?.trim();
  if (!from) return null;
  return from.includes("<") ? from : `altship <${from}>`;
}

/** The link an invited person opens to accept (the dashboard's /invite/<id> page). */
export function inviteLink(inviteId: string): string {
  return `${dashboardUrl()}/invite/${inviteId}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// The mark shown next to the wordmark; served by the live dashboard so it
// loads whatever DASHBOARD_URL is locally.
const LOGO_URL = "https://pilot.altship.io/favicon.png";
const FONT = "font-family:Arial,Helvetica,sans-serif;";

/**
 * An email as HTML, matching the dashboard's sign-in card: white card with a
 * hairline border on #fafafa, Arial, a black square-cornered button. Tables
 * and inline styles only, since that's what email clients render. Every part
 * is plain text and escaped here, except `introHtml`, which the caller builds
 * from escaped pieces.
 */
function cardHtml(parts: { title: string; preheader: string; introHtml: string; box?: string; button: string; link: string; footer: string }): string {
  const title = escapeHtml(parts.title);
  const link = escapeHtml(parts.link);
  const box = parts.box
    ? `<p style="margin:0 0 24px;padding:12px 14px;background:#fafafa;border:1px solid #e8e8e8;${FONT}font-size:13px;line-height:1.6;color:#111111;white-space:pre-wrap;">${escapeHtml(parts.box)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(parts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;">
<tr><td style="padding:32px 28px;background:#ffffff;border:1px solid #e8e8e8;${FONT}color:#111111;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:8px;vertical-align:middle;"><img src="${LOGO_URL}" width="28" height="28" alt="" style="display:block;border:0;"></td>
<td style="padding-right:8px;vertical-align:middle;${FONT}font-size:18px;font-weight:500;color:#111111;">altship.</td>
<td style="padding-left:8px;border-left:1px solid #e8e8e8;vertical-align:middle;${FONT}font-size:12px;color:#595959;">pilot</td>
</tr></table>
<h1 style="margin:28px 0 6px;${FONT}font-size:22px;line-height:1.3;font-weight:500;color:#111111;">${title}</h1>
<p style="margin:0 0 20px;${FONT}font-size:13px;line-height:1.5;color:#595959;">${parts.introHtml}</p>
${box}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="#111111" style="background:#111111;border-radius:2px;"><a href="${link}" style="display:block;padding:12px 14px;${FONT}font-size:13px;color:#ffffff;text-decoration:none;">${escapeHtml(parts.button)}</a></td>
</tr></table>
<p style="margin:20px 0 0;${FONT}font-size:11px;line-height:1.5;color:#8a8a8a;">Or open this link:<br><a href="${link}" style="color:#595959;word-break:break-all;">${link}</a></p>
</td></tr>
<tr><td align="center" style="padding:16px 12px 0;${FONT}font-size:11px;line-height:1.5;color:#8a8a8a;">${escapeHtml(parts.footer)}<br><a href="https://altship.io" style="color:#595959;">altship.io</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const strong = (text: string) => `<strong style="font-weight:500;color:#111111;">${escapeHtml(text)}</strong>`;

/** Sends one email through Resend. False if email isn't set up or the send failed; never throws. */
async function send(kind: string, message: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = sender();
  if (!apiKey || !from) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`${kind} email failed: Resend responded ${res.status}.`);
    return res.ok;
  } catch (err) {
    console.error(`${kind} email failed:`, err instanceof Error ? err.name : "unknown error");
    return false;
  }
}

/** Whether emails can be sent at all. */
export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY) && sender() !== null;
}

/** Emails an invite to a private MCP server. Returns false if email isn't configured or the send failed. */
export async function sendInviteEmail(invite: {
  to: string;
  /** Shown as who invited them, when known. */
  inviterEmail: string | null;
  /** The server's API title. Comes from the owner's OpenAPI spec, so it's escaped. */
  serverName: string;
  link: string;
}): Promise<boolean> {
  // Keeps the subject to one line whatever the spec's title contains.
  const name = oneLine(invite.serverName, 80) || "an MCP server";
  const inviter = invite.inviterEmail ?? "Someone";
  const intro = `${inviter} invited you to use the ${name} MCP server on altship.`;
  const steps = "Sign in, or create an account, with this email address. You'll then get the server's URL to add in Claude, ChatGPT or another MCP client.";
  const ignore = "If you weren't expecting this, you can ignore this email.";

  return send("Invite", {
    to: invite.to,
    subject: `You're invited to use ${name} on altship`,
    text: `${intro}\n\n${steps}\n\n${invite.link}\n\n${ignore}`,
    html: cardHtml({
      title: `You're invited to use ${name}`,
      preheader: `${inviter} invited you to use the ${name} MCP server.`,
      introHtml: `${escapeHtml(inviter)} invited you to use the ${strong(name)} MCP server on altship.`,
      box: steps,
      button: "Accept the invite",
      link: invite.link,
      footer: ignore,
    }),
  });
}

/** One line of at most `max` characters, whatever the text contains. */
function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The dashboard page for one run of an agent, where it can be read in full and approved. */
export function runLink(agentId: string, sessionId: string): string {
  // A run that never started has no session to open: show the agent's run log.
  if (sessionId.startsWith("drun_")) return `${dashboardUrl()}/agents/${agentId}/runs`;
  return `${dashboardUrl()}/agents/${agentId}?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Tells an agent's owner about a scheduled run: it's waiting for their
 * approval, it failed, or (when they asked for results) what it answered.
 * Carries the agent's reply only, never what its tools were given or returned.
 */
export async function sendRunEmail(run: {
  to: string;
  agentId: string;
  /** Chosen by the owner; escaped. */
  agentName: string;
  sessionId: string;
  status: "requires_action" | "failed" | "completed" | "running";
  scheduleLabel: string | null;
  output: string | null;
}): Promise<boolean> {
  const name = oneLine(run.agentName, 80) || "Your agent";
  const when = run.scheduleLabel ? ` (${run.scheduleLabel})` : "";
  const link = runLink(run.agentId, run.sessionId);
  const copy =
    run.status === "requires_action"
      ? { subject: `${name} is waiting for your approval`, title: `${name} needs your approval`, intro: `A scheduled run${when} has paused before a step that needs your say-so. It will wait until you approve or decline.`, button: "Review and approve" }
      : run.status === "failed"
        ? { subject: `${name}: a scheduled run failed`, title: `A scheduled run of ${name} failed`, intro: `A scheduled run${when} stopped before it finished.`, button: "See what happened" }
        : { subject: `${name}: scheduled run finished`, title: `${name} finished a scheduled run`, intro: `Here's what it came back with${when}.`, button: "Open the run" };
  const output = run.output ? (run.output.length > 2000 ? `${run.output.slice(0, 1999)}…` : run.output) : undefined;
  const footer = "You get this because one of your altship agents runs on a schedule.";

  return send("Run", {
    to: run.to,
    subject: copy.subject,
    text: `${copy.intro}${output ? `\n\n${output}` : ""}\n\n${link}\n\n${footer}`,
    html: cardHtml({ title: copy.title, preheader: copy.intro, introHtml: escapeHtml(copy.intro), box: output, button: copy.button, link, footer }),
  });
}
