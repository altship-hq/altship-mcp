import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { signOut } from "./auth.js";

// Signed-in user at the foot of the sidebar; opens a menu with Sign out.

/** Name, email and picture from whichever way the user signed in (GitHub, Google or email). */
function describe(user: User) {
  const meta = user.user_metadata ?? {};
  const email = user.email ?? "";
  const name: string = meta.full_name || meta.name || meta.user_name || email.split("@")[0] || "Account";
  const avatar: string | undefined = meta.avatar_url || meta.picture || undefined;
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return { name, email, avatar, initials: initials || "?" };
}

export default function Profile({ user }: { user: User }) {
  const { name, email, avatar, initials } = describe(user);
  const [open, setOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <div className="profile" ref={rootRef}>
      {open && (
        <div className="profile-menu" id="profile-menu" role="menu">
          <div className="profile-menu-head">
            <strong>{name}</strong>
            {email && <span>{email}</span>}
          </div>
          <button type="button" role="menuitem" onClick={() => signOut()}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16H8M13 6.5 16.5 10 13 13.5M16.5 10H8" />
            </svg>
            Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        className="profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "profile-menu" : undefined}
        aria-label={`Account: ${name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="profile-avatar" aria-hidden="true">
          {avatar && !avatarFailed ? (
            <img src={avatar} alt="" width="28" height="28" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} />
          ) : (
            initials
          )}
        </span>
        <span className="profile-text">
          <span className="profile-name">{name}</span>
          {email && <span className="profile-email">{email}</span>}
        </span>
        <svg className="profile-chevron" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 8 4-4 4 4M6 12l4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}
