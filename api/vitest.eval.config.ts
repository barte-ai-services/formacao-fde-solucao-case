import { defineConfig } from 'vitest/config';

// #65 O eval da ordem provável roda à parte do gate (`npm run eval:predict` e `npm run eval:score`).
export default defineConfig({
  test: { include: ['eval/**/*.eval.ts'], testTimeout: 15 * 60 * 1000 },
});
