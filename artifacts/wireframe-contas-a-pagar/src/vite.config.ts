import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@barte-ai-services\/barte-ui-kit$/, replacement: resolve(here, "vendor/uikit/index.ts") },
      { find: /^@barte-ai-services\/shell-kit$/, replacement: resolve(here, "vendor/packages/kit/src/index.ts") },
      { find: /^@barte-ai-services\/shell-kit\/styles\.css$/, replacement: resolve(here, "vendor/packages/kit/src/styles.css") },
      { find: /^next\/navigation$/, replacement: resolve(here, "src/next-navigation.ts") },
    ],
  },
  css: { modules: { generateScopedName: "[name]__[local]__[hash:base64:5]" } },
  build: { assetsInlineLimit: 100_000_000, cssCodeSplit: false, rollupOptions: { output: { inlineDynamicImports: true } } },
});
