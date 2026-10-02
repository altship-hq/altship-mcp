import { useEffect, useState, type AnchorHTMLAttributes } from "react";

// Minimal pushState routing. Paths are relative to Vite's base ("/"), so
// "mcp/servers" is served at /mcp/servers.
const BASE = import.meta.env.BASE_URL;

function currentPath(): string {
  const pathname = window.location.pathname;
  if (pathname === BASE.replace(/\/$/, "")) return "";
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, "");
  return path.replace(/\/$/, "");
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return path;
}

export function navigate(to: string) {
  window.history.pushState(null, "", BASE + to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

/** An <a> that navigates client-side on a plain left click and behaves normally otherwise (new tab, etc.). */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...rest}
      href={BASE + to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
