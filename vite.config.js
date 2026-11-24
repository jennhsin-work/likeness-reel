import { defineConfig } from "vite";
export default defineConfig({ server: { port: 5174, proxy: { "/api": "http://localhost:8790", "/media": "http://localhost:8790" } } });
