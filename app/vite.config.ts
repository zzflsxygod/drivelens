import { defineConfig } from "vite";
import pkg from "./package.json";
const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 1420, strictPort: true, host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2020", outDir: "dist" },
});
