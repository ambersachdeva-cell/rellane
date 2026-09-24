import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    // Production shipped a 1.1 MB sourcemap with full `sourcesContent` inside
    // the asar, handing the entire TypeScript source to anyone who opened the
    // app bundle. Keep maps for development only.
    sourcemap: process.env["NODE_ENV"] !== "production",
    target: "chrome150",
    rollupOptions: {
      input: {
        // The full window.
        main: resolve(import.meta.dirname, "index.html"),
        // The ⌥Space overlay. A separate document so it loads without the
        // workbench's chunks — the overlay's whole value is opening instantly.
        overlay: resolve(import.meta.dirname, "overlay.html")
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
