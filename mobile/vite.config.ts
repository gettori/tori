import { defineConfig } from "vite-plus";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],
  publicDir: "../public",
  // The chat's syntax worker loads each grammar by dynamic import, and an iife
  // worker cannot split chunks.
  worker: { format: "es" as const },
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    // The chat components are imported from the desktop app's src.
    fs: { allow: [".."] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
