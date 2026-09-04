/**
 * A Supabase `SupportedStorage` implementation backed by a cookie instead of
 * localStorage. localStorage is scoped per-origin (scheme+host+port), so a
 * session set on altship.io would be invisible on mcp.altship.io -- a
 * cookie with `Domain=.altship.io` is visible to every subdomain, which is
 * exactly the "sign in once, use it on every altship product" behavior we
 * want. In local dev, pass "localhost" as the domain: cookies (unlike
 * origins) ignore port, so this also works across localhost:5173 vs :5174.
 */
export function createCookieStorage(domain: string) {
  const maxAgeSeconds = 60 * 60 * 24 * 100; // 100 days, refreshed on each write

  return {
    getItem(key: string): string | null {
      const match = document.cookie.match(new RegExp(`(?:^|; )${encodeURIComponent(key)}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : null;
    },
    setItem(key: string, value: string): void {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; Domain=${domain}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
    },
    removeItem(key: string): void {
      document.cookie = `${encodeURIComponent(key)}=; Domain=${domain}; Path=/; Max-Age=0`;
    },
  };
}
