import { config } from "./config.js";
import { createBunApp, MAX_REQUEST_BODY_SIZE } from "./bun-app.js";

const { app, runtime, realtime, insecureAdminKey } = createBunApp(config);

if (process.env.NODE_ENV === "production" && insecureAdminKey) {
  throw new Error("ADMIN_KEY must be a unique random value with at least 32 characters in production.");
}

app.listen({
  hostname: config.serverHost,
  port: config.port,
  ...realtime.handler(),
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
});

console.log(`Server listening on http://${config.serverHost}:${config.port} (Bun + Elysia)`);
if (insecureAdminKey) {
  console.warn("ADMIN_KEY is missing or shorter than 32 characters; remote control is not secure.");
}
if (config.allowedGroupIds.size === 0) {
  console.warn("ALLOWED_GROUP_IDS is empty; no group will receive replies.");
}
if (config.priorityOnly && config.priorityRoutes.length === 0) {
  console.warn("Priority mode is enabled but no priority route is configured.");
}
await runtime.start();

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10000);
  forceExit.unref?.();
  try {
    await realtime.close();
    await Promise.all([runtime.stop(), app.stop()]);
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.error("Graceful shutdown failed:", error);
    process.exit(1);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
