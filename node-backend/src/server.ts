// Note: NO `import "@browserstack/ai-sdk/instrument"` here.
// Auto-instrumentation is initialized lazily inside /api/chat/auto via
// Observe.init() so Stage 3 (manual tracing) doesn't get double-instrumented.
import express, { type Request, type Response } from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { chatManualRouter } from "./routes/chatManual.js";
import { chatAutoRouter } from "./routes/chatAuto.js";
import { workflowsRouter } from "./routes/workflows.js";

/**
 * Origins the frontend may run on locally — matches CONTRACTS.md CORS spec.
 */
const ALLOWED_ORIGINS = [
  "http://localhost:8000",
  "http://localhost:3001",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:3001",
];

/**
 * Where the shared static frontend is mounted inside the Docker image.
 * The Dockerfile in `shared-frontend/` copies its contents to /app/shared-frontend.
 */
const STATIC_ROOT = "/app/shared-frontend";

const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: "*",
  })
);
app.use(express.json({ limit: "1mb" }));

/**
 * GET /healthz — docker-compose healthcheck target.
 */
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, runtime: "node" });
});

// API routes register before the static middleware so they take priority.
app.use("/api/auth", authRouter);
app.use("/api/chat", chatManualRouter);
app.use("/api/chat", chatAutoRouter);
app.use("/api/workflows", workflowsRouter);

// Static frontend — catches everything below /api/*.
app.use(express.static(STATIC_ROOT));

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[node-backend] listening on :${PORT}`);
});
