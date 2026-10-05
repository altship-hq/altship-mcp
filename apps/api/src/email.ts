// Invite emails, sent through Resend's HTTP API. Optional: without
// RESEND_API_KEY and INVITE_FROM_EMAIL nothing is sent, and the owner shares
// the invite link themselves.
//
//   RESEND_API_KEY     Resend API key
//   INVITE_FROM_EMAIL  verified sender, e.g. "altship <invites@altship.io>"
//   DASHBOARD_URL      where invite links point, e.g. https://pilot.altship.io
//                      (defaults to the first ALLOWED_ORIGINS entry)

function dashboardUrl(): string {
  const url = process.env.DASHBOARD_URL ?? (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",")[0];
  return url.trim().replace(/\/$/, "");
}

/** The link an invited person opens to accept (the dashboard's /invite/<id> page). */
export function inviteLink(inviteId: string): string {
  return `${dashboardUrl()}/invite/${inviteId}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
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
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.INVITE_FROM_EMAIL;
  if (!apiKey || !from) return false;

  // Keeps the subject to one line whatever the spec's title contains.
  const name = invite.serverName.replace(/\s+/g, " ").trim().slice(0, 80) || "an MCP server";
  const inviter = invite.inviterEmail ?? "Someone";
  const intro = `${inviter} invited you to use the ${name} MCP server on altship.`;
  const steps = "Open the link below and sign in, or create an account, with this email address. You'll then get the server's URL to add in Claude, ChatGPT or another MCP client.";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [invite.to],
        subject: `You're invited to use ${name} on altship`,
        text: `${intro}\n\n${steps}\n\n${invite.link}\n\nIf you weren't expecting this, you can ignore this email.`,
        html: `<p>${escapeHtml(intro)}</p><p>${escapeHtml(steps)}</p><p><a href="${escapeHtml(invite.link)}">Accept the invite</a></p><p>If you weren't expecting this, you can ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`Invite email failed: Resend responded ${res.status}.`);
    return res.ok;
  } catch (err) {
    console.error("Invite email failed:", err instanceof Error ? err.name : "unknown error");
    return false;
  }
}
