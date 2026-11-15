import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // O shell-kit pede `next/navigation` (usePathname e useRouter). Sem Next aqui: o stand-in.
      { find: /^next\/navigation$/, replacement: at("./src/router/navigation.ts") },
      { find: /^@domain$/, replacement: at("../api/src/domain/index.ts") },
    ],
  },
  server: {
    // Em dev, a API é o `wrangler dev` da pasta api/. Mesma origem para o navegador.
    proxy: { "/me": "http://localhost:8787", "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // O shell-kit chega como TS fonte em node_modules, e os kits importam CSS: o Vitest precisa
    // transformá-los (e aplicar o alias de `next/navigation`) em vez de entregá-los crus ao Node.
    server: { deps: { inline: [/@barte-ai-services\//, /barte-design-system/] } },
  },
});
