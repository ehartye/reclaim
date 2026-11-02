import { createApp } from "./app.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function startService({
  port = Number(process.env.PORT || 4318),
  dev = process.argv.includes("--dev"),
  dataDir = process.env.RECLAIM_DATA_DIR,
  appFactory = createApp,
  logger = console,
} = {}) {
  // Refuse invalid configuration before initializing application resources.
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid HTTP port.");
  let app, closing;
  const close = () => (closing ??= Promise.resolve().then(() => app.close()));
  const runtimeFailure = () => {
    process.exitCode = 1;
    logger.error("Reclaim HTTP server failed.");
    void close().catch(() => logger.error("Reclaim could not finish closing."));
  };
  try {
    app = await appFactory({ dev, dataDir });
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        app.server.off("error", failed);
        app.server.off("listening", ready);
      };
      const failed = (cause) => {
        cleanup();
        reject(cause);
      };
      const ready = () => {
        cleanup();
        app.server.on("error", runtimeFailure);
        resolve();
      };
      app.server.once("error", failed);
      app.server.once("listening", ready);
      try {
        app.server.listen(port, "127.0.0.1");
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    });
    logger.log(
      `Reclaim is ready at http://127.0.0.1:${app.server.address().port}`,
    );
    return { app, close };
  } catch {
    if (app) {
      try {
        await close();
      } catch {
        logger.error("Reclaim could not finish closing.");
      }
    }
    throw new Error("Reclaim could not start.");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const service = await startService();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        void service.close().then(
          () => process.exit(process.exitCode || 0),
          () => {
            console.error("Reclaim could not finish closing.");
            process.exit(1);
          },
        );
      });
  } catch {
    console.error("Reclaim could not start.");
    process.exitCode = 1;
  }
}
