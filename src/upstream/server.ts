import express from "express";

const mode = process.env.UPSTREAM_MODE ?? "ok";
const port = Number(process.env.PORT ?? 4000);
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode });
});

app.all("*", async (req, res) => {
  if (mode === "slow") {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.UPSTREAM_DELAY_MS ?? 2000)));
  }
  if (mode === "flaky") {
    if (Math.random() < Number(process.env.UPSTREAM_ERROR_RATE ?? 0.7)) {
      res.status(503).json({ error: "upstream overloaded", path: req.path });
      return;
    }
  }
  res.json({
    upstream: mode,
    method: req.method,
    path: req.path,
    query: req.query,
    tenantId: req.header("x-tenant-id") ?? null,
    requestId: req.header("x-request-id") ?? null,
    echoed: req.body ?? null
  });
});

app.listen(port, () => {
  console.log(`upstream mode=${mode} port=${port}`);
});
