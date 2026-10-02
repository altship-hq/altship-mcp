import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served at altship.io/mcp/ via a rewrite on the landing site, so asset URLs
  // need the /mcp/ prefix (the landing site has its own /assets).
  base: "/mcp/",
  plugins: [react()],
});
