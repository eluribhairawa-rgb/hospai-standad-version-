import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";

export default defineConfig(({ command }) => {
  return {
    root: fs.realpathSync(process.cwd()),
    base: "/",
    esbuild: command === "build" ? { pure: ["console.log"], drop: ["debugger"] } : undefined,
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      cors: true,
      allowedHosts: true,
      hmr: process.env.HMR_CLIENT_PORT ? { clientPort: parseInt(process.env.HMR_CLIENT_PORT, 10) } : undefined,
      proxy: {
        "/api": process.env.API_TARGET || "http://127.0.0.1:8000",
      },
    },
    preview: {
      host: true,
      port: 4173,
      cors: true,
      allowedHosts: true,
      proxy: {
        "/api": process.env.API_TARGET || "http://127.0.0.1:8000",
      },
    },
  };
});
