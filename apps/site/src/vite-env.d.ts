/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dashboard origin that "Start building" links to. Defaults to https://pilot.altship.io (http://localhost:5173 in dev). */
  readonly VITE_DASHBOARD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
