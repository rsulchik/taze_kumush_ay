import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { resolve } from "node:path";

export default defineConfig({
  root: "mobile",
  envDir: resolve(__dirname),
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  resolve: {
    alias: {
      "@/lib/analyst.functions": resolve(__dirname, "src/lib/analyst.functions.mobile.ts"),
      "@tanstack/react-start": resolve(__dirname, "src/lib/start-client.ts"),
    },
  },
  build: {
    outDir: "www",
    emptyOutDir: true,
  },
});
