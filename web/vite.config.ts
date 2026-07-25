import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The whole UI compiles to ONE html file with every script and stylesheet
 * inlined, because `scripts/embed.ts` then bakes that file into a TS module the
 * Bun binary carries. A multi-asset build would mean an asset router in
 * serve.ts and a second source of truth for cache headers; one file means
 * `digg serve` answers every GET from memory.
 *
 * Dev runs against a real `digg serve` on 9787 (see server.proxy) so the React
 * app in `bun run dev` talks to the same kubectl-backed API the binary ships.
 */
export default defineConfig({
    plugins: [react(), viteSingleFile()],
    build: {
        target: "esnext",
        assetsInlineLimit: 100_000_000,
        chunkSizeWarningLimit: 4096,
        cssCodeSplit: false,
        reportCompressedSize: false,
        sourcemap: false,
    },
    server: {
        port: 9788,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:9787",
                changeOrigin: true,
                ws: true,
            },
        },
    },
});
