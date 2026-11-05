import { createServer, type Server } from "node:http";
import { makeRouter, type Routes } from "./router.js";

/** Binds the router to a port. On SIGTERM or SIGINT it stops accepting requests, then runs `onStop` (pending writes) before exiting. */
export function startServer(routes: Routes, opts: { host: string; port: number; onStop: () => Promise<void>; onListen: () => void }): Server {
  const http = createServer(makeRouter(routes));
  http.requestTimeout = 120_000;
  http.listen(opts.port, opts.host, opts.onListen);
  const stop = (): void => {
    http.close();
    void opts.onStop().catch(() => undefined).finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return http;
}
