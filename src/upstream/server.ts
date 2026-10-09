import { createUpstreamApp, type UpstreamMode } from "./app.js";

const mode = (process.env.UPSTREAM_MODE ?? "ok") as UpstreamMode;
const port = Number(process.env.PORT ?? 4000);

const app = createUpstreamApp({
  mode,
  delayMs: Number(process.env.UPSTREAM_DELAY_MS ?? 2000),
  errorRate: Number(process.env.UPSTREAM_ERROR_RATE ?? 0.7)
});

app.listen(port, () => {
  console.log(`upstream mode=${mode} port=${port}`);
});
