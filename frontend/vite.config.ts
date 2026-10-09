/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = process.env.GATEWAY_URL ?? "http://localhost:8080";

export default defineConfig({
  base: "/demo/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/demo/v1": gateway,
      "/sbx": gateway,
      "/api": gateway,
      "/health": gateway
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
