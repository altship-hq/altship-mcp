import type { NextFunction, Request, Response } from "express";
import { getSupabase } from "./supabase.js";

// Dashboard requests carry the signed-in user's Supabase access token
// (GitHub or Google sign-in) as `Authorization: Bearer <token>`.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /** Lowercased, and only set once the address is confirmed. */
      userEmail?: string;
    }
  }
}

/** Rejects the request with 401 unless it has a valid session; sets req.userId. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    return res.status(401).json({ error: "Sign in to continue." });
  }

  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Your session has expired. Sign in again." });
  }

  req.userId = data.user.id;
  if (data.user.email && data.user.email_confirmed_at) req.userEmail = data.user.email.toLowerCase();
  next();
}

/** The signed-in user's id. Only valid on routes behind requireAuth. */
export function userIdOf(req: Request): string {
  if (!req.userId) throw new Error("userIdOf() called on a route without requireAuth.");
  return req.userId;
}

/** The signed-in user's email address, if they've confirmed it. Only valid on routes behind requireAuth. */
export function confirmedEmailOf(req: Request): string | null {
  return req.userEmail ?? null;
}
