import { Server as BunEngine } from "@socket.io/bun-engine";
import { Server as SocketServer } from "socket.io";

export const createRealtime = ({ config, tokenMatches }) => {
  const engine = new BunEngine({
    path: "/socket.io/",
    pingInterval: 20000,
    pingTimeout: 10000,
    maxHttpBufferSize: 1e6,
    cors: { origin: config.clientOrigins },
  });
  const io = new SocketServer();
  let runtime;

  io.bind(engine);
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token ?? socket.handshake.headers["x-admin-key"];
    if (!tokenMatches(token)) return next(new Error("Unauthorized"));
    if (io.of("/").sockets.size >= config.maxSocketConnections) {
      return next(new Error("Too many connections"));
    }
    return next();
  });
  io.on("connection", (socket) => {
    socket.emit("status", runtime.snapshot());
    socket.emit("orders", runtime.orders(config.maxOrderHistory));
  });

  return {
    engine,
    io,
    setRuntime(value) {
      runtime = value;
    },
    broadcast(event, payload) {
      io.emit(event, payload);
    },
    handleRequest(request, server) {
      return engine.handleRequest(request, server);
    },
    handler() {
      return engine.handler();
    },
    async close() {
      await io.close();
    },
  };
};
