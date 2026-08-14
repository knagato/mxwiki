import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

// matrix-js-sdk の rust-crypto WASM は top-level await を使うため esnext を指定。
// crypto-wasm は事前バンドルから除外して WASM を素直にロードさせる。
//
// HTTPS 化: WebCrypto(crypto.subtle) はセキュアコンテキスト必須。tailnet の http:// は
// 非セキュア扱いなので、tailscale cert の正式証明書で Vite 自体を HTTPS 提供する。
// さらに /_matrix・/_synapse を Synapse(8008) へリバースプロキシし、SPA と homeserver を
// 単一オリジン(https://host:8900)に集約 → CORS も mixed content も不要。
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 8900,
    allowedHosts: [".ts.net"],
    https: {
      cert: readFileSync(new URL("./.certs/ts.crt", import.meta.url)),
      key: readFileSync(new URL("./.certs/ts.key", import.meta.url)),
    },
    proxy: {
      "/_matrix": { target: "http://127.0.0.1:8008", changeOrigin: true },
      "/_synapse": { target: "http://127.0.0.1:8008", changeOrigin: true },
    },
  },
  build: { target: "esnext" },
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
    exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
  },
});
