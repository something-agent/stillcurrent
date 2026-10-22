/** Cloudflare Workers entry point. The app is built lazily on the first request (no I/O in global scope). */
import type { Hono } from "hono";
import { buildApp } from "./app";
import { loadSettings, type Env } from "./config";

let cached: { key: string; app: Hono } | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const key = JSON.stringify(env ?? {});
    if (!cached || cached.key !== key) cached = { key, app: buildApp(loadSettings(env)) };
    return cached.app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
