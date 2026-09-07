import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cors } from "@elysiajs/cors";
import { Elysia, file } from "elysia";
import { createApiRoutes } from "./api-routes.js";
import { createTokenMatcher, isInsecureAdminKey } from "./auth.js";
import { createBackendRuntime } from "./backend-runtime.js";
import { createRealtime } from "./realtime.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultClientDist = path.resolve(currentDir, "../../client/dist");
export const MAX_JSON_BODY_SIZE = 1024 * 1024;
export const MAX_REQUEST_BODY_SIZE = MAX_JSON_BODY_SIZE + (64 * 1024);

const chunkedJsonExceedsLimit = (request, body) => {
  if (request.headers.has("content-length")) return false;
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return false;
  return new Blob([JSON.stringify(body ?? null)]).size > MAX_JSON_BODY_SIZE;
};

const resolveStaticFile = async (clientDist, wildcard = "") => {
  const candidate = path.resolve(clientDist, String(wildcard));
  const insideClientDist = candidate === clientDist || candidate.startsWith(`${clientDist}${path.sep}`);
  if (insideClientDist) {
    try {
      const info = await fs.stat(candidate);
      if (info.isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path.join(clientDist, "index.html");
};

export const createBunApp = (config, { clientDist = defaultClientDist } = {}) => {
  const clientIndex = path.join(clientDist, "index.html");
  const tokenMatches = createTokenMatcher(config.adminKey);
  const realtime = createRealtime({ config, tokenMatches });
  const runtime = createBackendRuntime({
    config,
    broadcast: (event, payload) => realtime.broadcast(event, payload),
  });
  realtime.setRuntime(runtime);

  const app = new Elysia({ name: "zalo-auto-reply" })
    .onRequest(({ request, set }) => {
      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_SIZE) {
        set.status = 413;
        return { error: "Payload Too Large" };
      }
    })
    .onBeforeHandle(({ request, body, set }) => {
      if (chunkedJsonExceedsLimit(request, body)) {
        set.status = 413;
        return { error: "Payload Too Large" };
      }
    })
    .use(cors({ origin: config.clientOrigins }))
    .get("/health", () => ({ status: "ok" }))
    .all("/socket.io/", ({ request, server }) => realtime.handleRequest(request, server))
    .use(createApiRoutes({ config, runtime, tokenMatches }))
    .get("/", () => file(clientIndex))
    .get("/*", async ({ params }) => file(await resolveStaticFile(clientDist, params["*"])));

  return { app, runtime, realtime, insecureAdminKey: isInsecureAdminKey(config.adminKey) };
};
