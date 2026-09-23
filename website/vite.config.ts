import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        referral: resolve(import.meta.dirname, "referral.html"),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    cors: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3101",
        changeOrigin: false,
      },
    },
  },
});
