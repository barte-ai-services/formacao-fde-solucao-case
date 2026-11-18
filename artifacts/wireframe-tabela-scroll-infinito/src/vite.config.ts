import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = import.meta.dirname;
const webSrc = process.env.WEB_SRC ?? resolve(here, "../../../web/src");
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // #160 As grids do portal, as mesmas de web/src, sem copiar.
      { find: /^@portal\//, replacement: `${webSrc}/` },
      // #160 O shell-kit pede `next/navigation`: o stand-in em memória (a página abre por duplo clique, em file://, sem History API).
      { find: /^next\/navigation$/, replacement: resolve(here, "src/next-navigation.ts") },
      { find: /^@domain$/, replacement: resolve(webSrc, "../../api/src/domain/index.ts") },
    ],
  },
  css: { modules: { generateScopedName: "[name]__[local]__[hash:base64:5]" } },
  build: { assetsInlineLimit: 100_000_000, cssCodeSplit: false, rollupOptions: { output: { inlineDynamicImports: true } } },
});
