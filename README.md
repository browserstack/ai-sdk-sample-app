# Sandbox SDK Sample App

A runnable, in-browser walkthrough of the **BrowserStack AI SDK**. It exercises the full SDK surface — auth, manual tracing, auto tracing, prompt compile, dataset runs, eval execution, and experiment runs — and streams every SDK call as a live code snippet so you can see exactly what the SDK is doing.

The same frontend ships with **two interchangeable backends** (Python FastAPI + Node Express). A toggle in the sidebar flips between them so you can see the SDK surface in either language without restarting anything.

---

## Prerequisites

You'll need the following before starting:

1. **Docker + Docker Compose** installed locally.
2. A **BrowserStack Sandbox project** at https://evals.browserstack.com.
3. **API keys** for that project — see "One-time project setup" below.
4. An **OpenAI key** and/or **Anthropic key** — at least one. Used by the chat stages and by the LLM-based evaluators in the workflows.
5. The **two SDK tarballs** dropped into `sdk-vendor/` — see "Drop the SDK tarballs in place" below.

---

## Drop the SDK tarballs in place

Both backends install the SDK from local tarballs (vendored under `sdk-vendor/`, gitignored). Grab the latest builds — typically distributed as static links such as `https://static.testops.ai/sdk/python/browserstack_ai_sdk-<version>.tar.gz` and `https://static.testops.ai/sdk/nodejs/browserstack-ai-sdk-<version>.tar.gz` — and place them at:

```
sdk-vendor/
├── browserstack_ai_sdk-<version>.tar.gz       # Python SDK
└── browserstack-ai-sdk-<version>.tar.gz       # Node SDK (also symlinked as .tgz for npm)
```

The `python-backend/Dockerfile` and `node-backend/package.json` reference these filenames explicitly. **If your tarball versions differ**, update:

- `python-backend/Dockerfile` — the two `COPY` + `pip install` lines pointing at `browserstack_ai_sdk-<version>.tar.gz`
- `node-backend/Dockerfile` — the `COPY` line pointing at `browserstack-ai-sdk-<version>.tar.gz`
- `node-backend/package.json` — the `"@browserstack/ai-sdk": "file:../sdk-vendor/browserstack-ai-sdk-<version>.tgz"` dependency

If you're not sure where to get the tarballs, ask the AI SDK team for the latest static link.

---

## One-time project setup in Sandbox

Open your project at https://evals.browserstack.com and do **both** of these once:

### 1. Generate Sandbox API keys

- Click the **gear icon** → **Project Settings** → **API keys**.
- Generate a key pair. You'll get a public key (`pk-to-...`) and a secret key (`sk-to-...`).
- You'll paste these into the app's auth screen.

### 2. Add an LLM connection on the project

This step is easy to miss and the workflows will fail silently without it (every evaluation comes back as 0).

- Same gear icon → **Project Settings** → **LLM connections**.
- Add a connection for the model the evaluators will call. The sample app's evaluators are configured for **`openai / gpt-4o-mini`** by default, so add an OpenAI connection there.
- If you want the workflows to use Anthropic instead, add an Anthropic connection and update the `modelParams` in the workflow code accordingly.

---

## Run it

```bash
docker compose up --build
```

This spins up two backends side-by-side:

| Service | URL | Runtime |
|---|---|---|
| Python backend | http://localhost:8000 | FastAPI on port 8000 |
| Node backend | http://localhost:3001 | Express on port 3001 |

Both serve the same frontend at `/`. **Open either URL** in your browser — the UI is identical. The sidebar has a **Backend** toggle (Python / Node) that flips which one your clicks talk to.

---

## Using the app

### 1. Connect

On the **Sandbox keys** screen, paste:

- **Sandbox public key** (`pk-to-...`)
- **Sandbox secret key** (`sk-to-...`)
- **At least one** of: OpenAI key (`sk-...`) or Anthropic key (`sk-ant-...`)

Click **Validate & continue**. The app calls `experiments.list()` against your project to verify the keys and discover your project ID.

Keys are kept in browser memory only — refresh and you'll be re-prompted. They're never sent anywhere except `evals.browserstack.com`.

### 2. Tracing

Two pages demonstrating the two tracing modes:

- **Manual tracing** — chat that wraps the LLM call in `client.trace()` / `start_generation()` / `gen.update()` / `gen.end()` / `trace.score()` / `trace.update()`.
- **Auto tracing** — same chat, but `Observe.init()` instruments the OpenAI/Anthropic SDK call automatically. Pick provider + model from the dropdown.

Both pages always show the static SDK script on the right and link to your project's traces page in Sandbox.

### 3. Workflows

Four end-to-end workflows. All are **idempotent** — re-running them reuses existing artifacts instead of duplicating.

| Workflow | What it does |
|---|---|
| **Prompt Compile** | Get-or-create a templated prompt (`support-reply-generator`), call `Prompt.compile(...)` with user-supplied tone / customer_name / issue, send the compiled prompt to OpenAI. |
| **Dataset Run** | Get-or-create a dataset (`support-bot-reranker-eval`), create a dataset run, seed 3 items, verify by listing them back. |
| **Eval Execution** | Look up the `support-quality` evaluator list, walk its `evaluatorConfigs[]`, build the rich payload, run `Evaluate.evaluation_execution.evaluate(...)` for each row in the dataset. |
| **Experiment Run** | The full 8-phase orchestration — prompt → dataset → tools → evaluators → evaluator-list → experiment → run → subscribe. |

Each workflow shows the live phase progression on the left and the SDK code being executed on the right. Every artifact created comes with a "View in Sandbox" link.

---

## Troubleshooting

**"Authenticated but no experiments found"** — your project is empty. Either run a workflow first, or create an experiment in Sandbox manually so `experiments.list()` returns something.

**Workflows complete but every score is 0** — your project doesn't have an LLM connection configured. See "One-time project setup" step 2 above.

**Tools API returns "Project not found"** in experiment-run Phase 4 — known upstream public-API issue with the Tools endpoints. The workflow continues past it; doesn't affect the rest.

**`sdk-vendor/` is empty** or **`docker compose` build fails on `pip install`/`npm install`** — you haven't placed the SDK tarballs yet. See "Drop the SDK tarballs in place" above.

---

## Layout

```
.
├── docker-compose.yml
├── python-backend/          FastAPI on :8000
│   ├── routes/                  auth, chat_manual, chat_auto, workflows
│   ├── workflows/               prompt_compile, dataset_run, eval_execution, experiment_run
│   └── services/                sdk_client, snippet_emitter, idempotency, llm
├── node-backend/            Express on :3001
│   └── src/                     mirror of python-backend, file-for-file
├── shared-frontend/         single HTML/CSS/JS UI mounted by both backends
└── sdk-vendor/              SDK tarballs (gitignored — source separately)
```

Both backends expose an identical SSE event shape (`phase-start` → `code-snippet` → `result` → `phase-end` → `done`) so the frontend doesn't care which one it's talking to.
