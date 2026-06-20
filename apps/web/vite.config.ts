import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/auth": "http://127.0.0.1:8765"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll("\\", "/");
          if (
            normalizedId.includes("/node_modules/react/") ||
            normalizedId.includes("/node_modules/react-dom/") ||
            normalizedId.includes("/node_modules/scheduler/")
          ) return "react-vendor";
          if (
            normalizedId.includes("/node_modules/@radix-ui/") ||
            normalizedId.includes("/node_modules/@floating-ui/") ||
            normalizedId.includes("/node_modules/aria-hidden/") ||
            normalizedId.includes("/node_modules/get-nonce/") ||
            normalizedId.includes("/node_modules/react-remove-scroll") ||
            normalizedId.includes("/node_modules/react-style-singleton") ||
            normalizedId.includes("/node_modules/use-callback-ref/") ||
            normalizedId.includes("/node_modules/use-sidecar/")
          ) return "ui-vendor";
          if (normalizedId.includes("/node_modules/dexie")) return "persistence-vendor";
          if (normalizedId.includes("/node_modules/lucide-react") || normalizedId.includes("/node_modules/react-resizable-panels")) return "ui-vendor";
          return undefined;
        }
      }
    }
  }
});
