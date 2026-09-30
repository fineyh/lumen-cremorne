import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // LUMEN_API points the dev server at a backend on another port
    proxy: { "/api": { target: process.env.LUMEN_API ?? "http://localhost:8000", changeOrigin: true } },
  },
});
