import { getSupabase } from "./supabase.js";

// What each plan gets. Every account is on "free" until it has a row in
// `accounts` saying otherwise; there's no billing yet, so plans are changed
// by hand (see supabase-schema.sql).

export interface PlanLimits {
  /** How many days of Observability history (tool calls, agent runs) are kept and shown. */
  retentionDays: number;
  /** How many schedules an account's agents may have between them. */
  schedules: number;
  /**
   * The most one scheduled run may cost, in US cents. Scheduled runs happen
   * with nobody watching, so each is capped; a run that reaches it stops.
   */
  scheduledRunCents: number;
}

export const PLANS = {
  free: { retentionDays: 7, schedules: 3, scheduledRunCents: 100 },
  // Placeholder for the first paid tier; the numbers aren't a pricing decision yet.
  pro: { retentionDays: 30, schedules: 20, scheduledRunCents: 300 },
} as const satisfies Record<string, PlanLimits>;

export type PlanName = keyof typeof PLANS;

function isPlan(value: unknown): value is PlanName {
  return typeof value === "string" && Object.hasOwn(PLANS, value);
}

/** The account's plan. Free when it has no row, an unknown plan, or the table doesn't exist yet. */
export async function planOf(userId: string): Promise<PlanName> {
  const { data, error } = await getSupabase().from("accounts").select("plan").eq("user_id", userId).maybeSingle();
  return !error && isPlan(data?.plan) ? data.plan : "free";
}

/** Accounts on a plan other than free. */
export async function paidAccounts(): Promise<Array<{ userId: string; plan: PlanName }>> {
  const { data, error } = await getSupabase().from("accounts").select("user_id,plan").neq("plan", "free");
  if (error) return [];
  return (data as Array<{ user_id: string; plan: unknown }>).flatMap((row) => (isPlan(row.plan) && row.plan !== "free" ? [{ userId: row.user_id, plan: row.plan }] : []));
}

/** The time before which a plan's records are out of its window (ISO). */
export function retentionCutoff(plan: PlanName, now = Date.now()): string {
  return new Date(now - PLANS[plan].retentionDays * 86_400_000).toISOString();
}
