import { createApp } from "./app.mjs";
const port = Number(process.env.PORT || 4318);
const app = await createApp({
  dev: process.argv.includes("--dev"),
  dataDir: process.env.RECLAIM_DATA_DIR,
});
app.server.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
app.server.listen(port, "127.0.0.1", () =>
  console.log(`Reclaim is ready at http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
