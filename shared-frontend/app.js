// Sidebar-driven walkthrough. Auth-gated; keys cached in sessionStorage.

const SANDBOX_PUBLIC_RE = /^pk-to-[a-z0-9-]+/i;
const SANDBOX_SECRET_RE = /^sk-to-[a-z0-9-]+/i;
const OPENAI_KEY_RE = /^sk-(?!ant-)(?!to-)[A-Za-z0-9_-]+/;
const ANTHROPIC_KEY_RE = /^sk-ant-[A-Za-z0-9_-]+/;
const KEY_RES = {
  sandboxPublic: SANDBOX_PUBLIC_RE,
  sandboxSecret: SANDBOX_SECRET_RE,
  openai: OPENAI_KEY_RE,
  anthropic: ANTHROPIC_KEY_RE,
};

const MODEL_OPTIONS = {
  openai:    [{ id: 'gpt-4o-mini', default: true }, { id: 'gpt-4o' }, { id: 'gpt-4-turbo' }, { id: 'o3-mini' }],
  anthropic: [{ id: 'claude-haiku-4-5', default: true }, { id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-7' }],
};

const BACKEND_URLS = { python: 'http://localhost:8000', node: 'http://localhost:3001' };

const PROVIDER_DEFS = [
  { id: 'openai',       label: 'OpenAI',                   requires: 'openai',    family: 'openai',    lc: null,        wire: 'openai' },
  { id: 'anthropic',    label: 'Anthropic',                requires: 'anthropic', family: 'anthropic', lc: null,        wire: 'anthropic' },
  { id: 'lc-openai',    label: 'LangChain → ChatOpenAI',   requires: 'openai',    family: 'openai',    lc: 'openai',    wire: 'langchain-openai' },
  { id: 'lc-anthropic', label: 'LangChain → ChatAnthropic',requires: 'anthropic', family: 'anthropic', lc: 'anthropic', wire: 'langchain-anthropic' },
];

// Plain-English copy for every workflow — describes what it actually DOES, not jargon.
const WORKFLOWS = {
  'experiment-run': {
    title: 'Experiment Run',
    short: 'Take a prompt + a list of test inputs and let the platform grade every answer.',
    subtitle: 'Sets up everything you need (prompt, dataset, evaluators) and runs the full evaluation in one go.',
    phases: [
      { title: 'Create prompt',          what: 'Save the prompt your bot uses ("walkthrough-support-bot") to Sandbox so the platform can run it.',                                why: 'Sandbox needs the prompt stored to call it on your behalf during the experiment.' },
      { title: 'Create dataset',         what: 'Create a dataset called "walkthrough-support-quality" — an empty bucket you\'ll fill with test questions.',                       why: 'Each test question + expected answer becomes a row the experiment will evaluate.' },
      { title: 'Upload CSV items',       what: 'Upload a CSV of test rows directly. The SDK reads the file, batches rows, and creates dataset items in one call.',              why: 'No loops, no parsing — just hand the SDK a file path and it handles ingestion.' },
      { title: 'Register tools',         what: 'Tell Sandbox which tools your bot can call (lookup_product, get_user_details, retrieve_docs, send_email).',                       why: 'When evaluation runs, the platform needs tool definitions to score tool-calling behaviour.' },
      { title: 'Create evaluators',      what: 'Create 4 evaluators that score each answer on different dimensions (helpful? right tool? fast?).',                                why: 'The evaluators are how Sandbox decides whether each answer is good — they\'re the rubric.' },
      { title: 'Build evaluator list',   what: 'Group the 4 evaluators into a named EvaluatorList — your reusable rubric.',                                                       why: 'Experiments run against an EvaluatorList, not individual evaluators. One handle to rule them all.' },
      { title: 'Create experiment',      what: 'Wire prompt + dataset + EvaluatorList together as a single Experiment. Re-creating overwrites cleanly.',                          why: 'The Experiment is the recipe; running it is what produces the actual scores.' },
      { title: 'Trigger run',            what: 'Trigger an Experiment Run. Sandbox calls your prompt against every dataset row, then runs the evaluators.',                       why: 'This is where the work actually happens — the platform calls the LLM, scores answers, stores results.' },
    ],
  },
  'dataset-run': {
    title: 'Dataset Run',
    short: 'Group test rows into a "run" you can compare against future runs.',
    subtitle: 'Same shape as Experiment Run, but lighter — useful for ad-hoc data collection without a full experiment.',
    phases: [
      { title: 'Create prompt',          what: 'Save the prompt you want to test against ("support-bot-reranker").',                                                                  why: 'Same idempotent shape as Workflow 1 — re-running just creates a new prompt version.' },
      { title: 'List prompt versions',   what: 'List existing versions to verify history.',                                                                                          why: 'Versioning is implicit: re-creating bumps the version. We just look at what already exists.' },
      { title: 'Create dataset',         what: 'Create a dataset called "support-bot-reranker-eval".',                                                                                why: 'Dataset runs need a parent dataset to attach to.' },
      { title: 'Create run + items',     what: 'Create a fresh DatasetRun, push 3 test rows into it, then read them back to confirm.',                                                why: 'Proves items actually land and are queryable from the SDK — a run with no items is dead weight.' },
    ],
  },
  'eval-execution': {
    title: 'Eval Execution',
    short: 'Take rows you already have outputs for and just score them.',
    subtitle: 'No new LLM calls — just feeds existing rows through your evaluators and aggregates the scores.',
    phases: [
      { title: 'Fetch evaluator list',   what: 'Look up the EvaluatorList that holds your scoring rules (Workflow 1 created this).',                                                why: 'Eval execution scores against an existing list — you don\'t define new evaluators here.' },
      { title: 'Inspect evaluators',     what: 'Fetch each evaluator and print its config — useful when debugging "why did my score come back zero?"',                            why: 'The SDK exposes the full evaluator definition; great for sanity-checking before you run.' },
      { title: 'Score each row',         what: 'For every row, run the EvaluatorList and capture per-evaluator scores.',                                                            why: 'This is the scoring step — it does NOT mutate any project state, so it\'s safe to re-run.' },
    ],
  },
  'prompt-compile': {
    title: 'Prompt Compile + LLM call',
    short: 'Save a templated prompt, fill in the variables, send it to an LLM.',
    subtitle: 'Shows the full lifecycle: store a prompt with {{variables}}, compile it with values, use the result as an LLM input.',
    phases: [
      { title: 'Create prompt',         what: 'Save "support-reply-generator" — a customer-support reply prompt with {{tone}}, {{customer_name}}, and {{issue}} placeholders.',     why: 'Templated prompts let you keep system messages out of code; teams version them in Sandbox.' },
      { title: 'Fetch prompt',          what: 'Call Prompt.get(name) — returns a PromptClient with the template + a .compile() method.',                                            why: 'The PromptClient is the bridge between Sandbox-stored prompts and your runtime — fetched once, cached.' },
      { title: 'Compile variables',     what: 'Call prompt.compile({ tone, customer_name, issue }) — substitutes the variables into the template.',                                 why: 'compile() is plain string interpolation — no LLM is called yet, it just produces the message you\'ll send.' },
      { title: 'Call LLM',              what: 'Send the compiled prompt to gpt-4o-mini and surface the reply.',                                                                     why: 'Closes the loop — proves the prompt template you stored actually drives a real completion end-to-end.' },
    ],
  },
};

// ─── Persistent state ───────────────────────────────────────────────────────
const SS_KEY = 'sandbox-walkthrough.session';
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveSession(s) { sessionStorage.setItem(SS_KEY, JSON.stringify(s)); }
function clearSession() { sessionStorage.removeItem(SS_KEY); }

const cached = loadSession();
const state = {
  route: cached?.route || 'connect',
  authed: !!cached?.projectId,
  backend: localStorage.getItem('backend') || 'python',
  keys: cached?.keys || { sandboxPublic: '', sandboxSecret: '', openai: '', anthropic: '' },
  projectId: cached?.projectId || null,
  manualChat: { provider: null, model: null, messages: [] },
  autoChat:   { provider: null, model: null, messages: [] },
  workflow:   { selected: null, phases: [], status: 'idle', summaryLink: null },
};

function persist() {
  saveSession({ keys: state.keys, projectId: state.projectId, route: state.route });
}

// ─── DOM helpers ────────────────────────────────────────────────────────────
function $(s, r = document) { return r.querySelector(s); }
function $$(s, r = document) { return [...r.querySelectorAll(s)]; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ─── Router ─────────────────────────────────────────────────────────────────
function navigate(route) {
  // workflow/<name> routes share a single section
  const [, workflowName] = route.match(/^workflow\/(.+)$/) || [];
  if (workflowName) {
    state.workflow.selected = workflowName;
    state.workflow.phases = WORKFLOWS[workflowName].phases.map((p, i) => ({
      index: i + 1, title: p.title, what: p.what, why: p.why, status: 'pending', events: [],
    }));
    state.workflow.status = 'idle';
    state.workflow.summaryLink = null;
    state.workflow.activeIndex = null;
  }

  state.route = route;
  persist();
  render();
}

function render() {
  // Sidebar items are always navigable; auth-gated items just don't run anything.
  $$('.sidebar-item').forEach(item => {
    item.classList.remove('locked');
    const r = item.dataset.route;
    item.classList.toggle('active', state.route === r);
  });

  // auth status dot
  const dot = $('#auth-status-dot');
  if (dot) dot.classList.toggle('connected', state.authed);

  // sign-out
  const so = $('#signout-btn');
  if (so) so.classList.toggle('hidden', !state.authed);

  // backend radios
  $$('input[name="backend"]').forEach(r => { r.checked = r.value === state.backend; });

  // route sections
  const routeKey = state.route.startsWith('workflow/') ? 'workflow' : state.route;
  $$('.route').forEach(s => s.classList.toggle('hidden', s.dataset.route !== routeKey));
  if (!state.route.startsWith('workflow/')) document.body.classList.remove('wf-mode-idle');

  if (state.route === 'connect')           validateConnectForm();
  if (state.route === 'tracing/manual')    renderManualSelectors();
  if (state.route === 'tracing/auto')      renderAutoSelectors();
  if (state.route.startsWith('workflow/')) {
    // Hydrate workflow state from the route on reload (state.workflow isn't persisted)
    const [, wfName] = state.route.match(/^workflow\/(.+)$/) || [];
    if (wfName && state.workflow.selected !== wfName) {
      state.workflow.selected = wfName;
      state.workflow.phases = WORKFLOWS[wfName].phases.map((p, i) => ({
        index: i + 1, title: p.title, what: p.what, why: p.why, status: 'pending', events: [],
      }));
      state.workflow.status = 'idle';
      state.workflow.summaryLink = null;
      state.workflow.activeIndex = null;
    }
    renderWorkflowPlayer();
  }
  applyAuthGate();
}

function applyAuthGate() {
  const isConnect = state.route === 'connect';
  const gated = !state.authed && !isConnect;

  // Inject / remove a "Sign in first" banner at top of the active route
  const activeSection = $(`section[data-route="${state.route.startsWith('workflow/') ? 'workflow' : state.route}"]`);
  if (!activeSection) return;
  let banner = activeSection.querySelector('.auth-gate-banner');
  if (gated && !banner) {
    banner = el('div', 'auth-gate-banner');
    banner.innerHTML = `
      <div>
        <strong>Connect first.</strong> Add your Sandbox keys before running anything here.
      </div>
      <button class="btn-primary text-sm" id="auth-gate-go">Go to Connect</button>`;
    activeSection.insertBefore(banner, activeSection.firstChild);
    $('#auth-gate-go').addEventListener('click', () => navigate('connect'));
  } else if (!gated && banner) {
    banner.remove();
  }

  // Disable run-y controls when gated
  const disable = (sel) => { const e = $(sel); if (e) e.disabled = gated; };
  disable('#manual-chat-input');
  disable('#auto-chat-input');
  disable('#workflow-rerun');
  // In-pane RUN button (rendered by renderWorkflowPlayer when idle)
  $$('.wf-preflight-cta .wf-run-btn').forEach(b => { b.disabled = gated; });
  // chat send buttons (the form's primary button)
  $$('#manual-chat-form button, #auto-chat-form button').forEach(b => { b.disabled = gated; });
}

// ─── Connect / auth ─────────────────────────────────────────────────────────
function validateConnectForm() {
  const k = state.keys;
  $$('input[data-key]').forEach(input => { if (input.value !== k[input.dataset.key]) input.value = k[input.dataset.key] || ''; });
  const sandboxOk = SANDBOX_PUBLIC_RE.test(k.sandboxPublic) && SANDBOX_SECRET_RE.test(k.sandboxSecret);
  const openaiOk = !k.openai || OPENAI_KEY_RE.test(k.openai);
  const anthropicOk = !k.anthropic || ANTHROPIC_KEY_RE.test(k.anthropic);
  const hasLLM = (k.openai && OPENAI_KEY_RE.test(k.openai)) || (k.anthropic && ANTHROPIC_KEY_RE.test(k.anthropic));
  const btn = $('#connect-btn');
  if (btn) btn.disabled = !(sandboxOk && openaiOk && anthropicOk && hasLLM);
}

function bindConnect() {
  $$('input[data-key]').forEach(input => {
    input.addEventListener('input', () => {
      const k = input.dataset.key;
      state.keys[k] = input.value.trim();
      const errEl = $(`[data-err="${k}"]`);
      if (errEl) errEl.textContent = (input.value && !KEY_RES[k].test(input.value)) ? 'Invalid format.' : '';
      validateConnectForm();
    });
  });
  $$('.eye-btn').forEach(btn => btn.addEventListener('click', () => {
    const target = $(`input[data-key="${btn.dataset.toggle}"]`);
    const showing = target.type === 'text';
    target.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  }));

  $('#connect-btn').addEventListener('click', runAuthValidate);
  $('#signout-btn').addEventListener('click', signOut);
  $$('input[name="backend"]').forEach(r => r.addEventListener('change', e => {
    state.backend = e.target.value;
    localStorage.setItem('backend', state.backend);
    render();
  }));
}

function signOut() {
  state.authed = false;
  state.projectId = null;
  state.keys = { sandboxPublic: '', sandboxSecret: '', openai: '', anthropic: '' };
  state.route = 'connect';
  clearSession();
  render();
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Sandbox-Public-Key': state.keys.sandboxPublic,
    'X-Sandbox-Secret-Key': state.keys.sandboxSecret,
  };
}
function chatHeaders() {
  const h = authHeaders();
  if (state.keys.openai)    h['X-OpenAI-Key']    = state.keys.openai;
  if (state.keys.anthropic) h['X-Anthropic-Key'] = state.keys.anthropic;
  return h;
}

async function runAuthValidate() {
  const msg = $('#auth-message');
  const host = $('#auth-snippet-host');
  const panel = $('#auth-snippet-panel');
  panel.textContent = '';
  host.classList.remove('hidden');
  msg.textContent = 'Validating…';
  $('#connect-btn').disabled = true;
  try {
    await consumeSSE(`${BACKEND_URLS[state.backend]}/api/auth/validate`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
    }, ev => {
      if (ev.type === 'code-snippet') renderSnippet(panel, ev);
      else if (ev.type === 'result') {
        if (ev.projectId) state.projectId = ev.projectId;
        msg.textContent = `✓ Connected to project ${state.projectId || ''}`;
        msg.style.color = '#047857';
        state.authed = true;
        persist();
        // Auto-redirect to manual tracing — don't show "Open project" since it
        // flashes and disappears with the redirect.
        setTimeout(() => navigate('tracing/manual'), 600);
      } else if (ev.type === 'error') {
        msg.textContent = `✗ ${ev.error || 'Authentication failed'}`;
        msg.style.color = '#b91c1c';
      }
    });
  } catch (err) {
    msg.textContent = `✗ ${err.message || err}`;
    msg.style.color = '#b91c1c';
  } finally {
    $('#connect-btn').disabled = false;
    render();
  }
}

// ─── Selector helpers (Stage 3 + Stage 4) ───────────────────────────────────
function availableProviders() { return PROVIDER_DEFS.map(p => ({ ...p, enabled: !!state.keys[p.requires] })); }
function pickFirstEnabled() { return availableProviders().find(p => p.enabled) || null; }
function fillProviderSelect(selectEl, currentId) {
  selectEl.textContent = '';
  const providers = availableProviders();
  providers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.enabled ? p.label : `${p.label} — add ${p.requires} key`;
    opt.disabled = !p.enabled;
    if (p.id === currentId) opt.selected = true;
    selectEl.appendChild(opt);
  });
  if (!providers.some(p => p.enabled && p.id === currentId)) {
    const f = providers.find(p => p.enabled);
    if (f) selectEl.value = f.id;
  }
}
function fillModelSelect(selectEl, family, currentId) {
  selectEl.textContent = '';
  const list = MODEL_OPTIONS[family] || MODEL_OPTIONS.openai;
  list.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.id;
    if (m.id === currentId) opt.selected = true;
    selectEl.appendChild(opt);
  });
  if (!list.some(m => m.id === currentId)) {
    const def = list.find(m => m.default) || list[0];
    selectEl.value = def.id;
    return def.id;
  }
  return currentId;
}
function defaultModelFor(family) {
  const list = MODEL_OPTIONS[family] || MODEL_OPTIONS.openai;
  return (list.find(m => m.default) || list[0]).id;
}

// ─── Static snippet templates (shown before any chat is sent) ──────────────
const SANDBOX_BASE = 'https://evals.browserstack.com';
function projectTracesUrl() {
  if (!state.projectId) return null;
  return `${SANDBOX_BASE}/project/${state.projectId}/logs/traces`;
}

function manualStaticSnippet(provider, model) {
  const fam = (PROVIDER_DEFS.find(p => p.id === provider)?.family) || 'openai';

  const sdkInit = [
    'from browserstack_ai_sdk import AISDK',
    '',
    'client = AISDK(',
    '    public_key="pk-to-***",',
    '    secret_key="sk-to-***",',
    ')',
  ];

  const traceWrap = [
    'trace = client.trace(',
    '    name="support-bot:chat",',
    '    input=user_message,',
    ')',
    'gen = trace.start_generation(',
    '    name="llm-call",',
    `    model="${model}",`,
    '    prompt=messages,',
    ')',
  ];

  const llmCall = fam === 'anthropic' ? [
    'import anthropic',
    '',
    'llm = anthropic.Anthropic(api_key="sk-ant-***")',
    '',
    'response = llm.messages.create(',
    `    model="${model}",`,
    '    max_tokens=1024,',
    '    messages=messages,',
    ')',
    'reply = response.content[0].text',
  ] : [
    'import openai',
    '',
    'llm = openai.OpenAI(api_key="sk-***")',
    '',
    'completion = llm.chat.completions.create(',
    `    model="${model}",`,
    '    messages=messages,',
    ')',
    'reply = completion.choices[0].message.content',
  ];

  const finishOpenAI = [
    'gen.update(',
    '    output=reply,',
    '    usage_details={',
    '        "input_tokens": completion.usage.prompt_tokens,',
    '        "output_tokens": completion.usage.completion_tokens,',
    '    },',
    ')',
    'gen.end()',
    '',
    'trace.score(name="verbose", value=1)',
    'trace.update(output=reply)',
  ];
  const finishAnthropic = [
    'gen.update(',
    '    output=reply,',
    '    usage_details={',
    '        "input_tokens": response.usage.input_tokens,',
    '        "output_tokens": response.usage.output_tokens,',
    '    },',
    ')',
    'gen.end()',
    '',
    'trace.score(name="verbose", value=1)',
    'trace.update(output=reply)',
  ];
  const finish = fam === 'anthropic' ? finishAnthropic : finishOpenAI;

  return [
    ...sdkInit,
    '',
    ...traceWrap,
    '',
    ...llmCall,
    '',
    ...finish,
  ].join('\n');
}

function autoStaticSnippet(provider, model) {
  const fam = (PROVIDER_DEFS.find(p => p.id === provider)?.family) || 'openai';
  const isLC = provider && provider.startsWith('lc-');

  const header = [
    'from browserstack_ai_sdk import AISDK, Observe',
    '',
    '# Installs OTel hooks for openai / anthropic / langchain.',
    'Observe.init()',
    '',
    'client = AISDK(',
    '    public_key="pk-to-***",',
    '    secret_key="sk-to-***",',
    ')',
  ];

  let providerBlock;
  if (isLC && fam === 'openai') {
    providerBlock = [
      'from langchain_openai import ChatOpenAI',
      '',
      'chat = ChatOpenAI(',
      '    api_key="sk-***",',
      `    model="${model}",`,
      ')',
      'response = chat.invoke(messages)',
    ];
  } else if (isLC && fam === 'anthropic') {
    providerBlock = [
      'from langchain_anthropic import ChatAnthropic',
      '',
      'chat = ChatAnthropic(',
      '    api_key="sk-ant-***",',
      `    model="${model}",`,
      '    max_tokens=1024,',
      ')',
      'response = chat.invoke(messages)',
    ];
  } else if (fam === 'anthropic') {
    providerBlock = [
      'import anthropic',
      '',
      'llm = anthropic.Anthropic(api_key="sk-ant-***")',
      '',
      'response = llm.messages.create(',
      `    model="${model}",`,
      '    max_tokens=1024,',
      '    messages=messages,',
      ')',
    ];
  } else {
    providerBlock = [
      'import openai',
      '',
      'llm = openai.OpenAI(api_key="sk-***")',
      '',
      'completion = llm.chat.completions.create(',
      `    model="${model}",`,
      '    messages=messages,',
      ')',
    ];
  }

  return [...header, '', ...providerBlock].join('\n');
}

function renderStaticChatPanel(panelId, kind, provider, model, stage) {
  const panel = $(`#${panelId}`);
  if (!panel) return;
  panel.textContent = '';
  const code = kind === 'manual'
    ? manualStaticSnippet(provider, model)
    : autoStaticSnippet(provider, model);
  renderSnippet(panel, {
    type: 'code-snippet',
    code,
    language: 'python',
    stage,
  });
  // Always-on "View traces in Sandbox" pill at top-right of the card.
  const url = projectTracesUrl();
  if (url) {
    attachSandboxLink(panel, { label: 'View traces in Sandbox', url });
  }
}

// ─── Manual chat ────────────────────────────────────────────────────────────
function renderManualSelectors() {
  const provSel = $('#manual-provider-select');
  const modelSel = $('#manual-model-select');
  if (!state.manualChat.provider) {
    const f = pickFirstEnabled();
    if (f) { state.manualChat.provider = f.id; state.manualChat.model = defaultModelFor(f.family); }
  }
  fillProviderSelect(provSel, state.manualChat.provider);
  state.manualChat.provider = provSel.value;
  const def = PROVIDER_DEFS.find(p => p.id === provSel.value);
  state.manualChat.model = fillModelSelect(modelSel, def?.family || 'openai', state.manualChat.model);
  // Pre-fill the SDK panel with the static script + project-traces link.
  if (state.manualChat.messages.length === 0) {
    renderStaticChatPanel('manual-sdk-panel', 'manual', state.manualChat.provider, state.manualChat.model, 'chat-manual');
  }
}
function bindManualSelectors() {
  $('#manual-provider-select').addEventListener('change', e => {
    state.manualChat.provider = e.target.value;
    const def = PROVIDER_DEFS.find(p => p.id === e.target.value);
    state.manualChat.model = defaultModelFor(def?.family || 'openai');
    renderManualSelectors();
  });
  $('#manual-model-select').addEventListener('change', e => { state.manualChat.model = e.target.value; });
}
function appendChatMsg(historyEl, role, text) {
  const node = el('div', role === 'user' ? 'chat-msg-user' : 'chat-msg-bot');
  if (role === 'bot' && window.marked) node.insertAdjacentHTML('beforeend', marked.parse(text));
  else node.textContent = text;
  historyEl.appendChild(node);
  historyEl.scrollTop = historyEl.scrollHeight;
}
function bindManualChat() {
  $('#manual-chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#manual-chat-input'), txt = input.value.trim();
    if (!txt) return;
    input.value = '';
    const hist = $('#manual-chat-history');
    // The SDK panel was rendered once on page entry: static snippet + the
    // project-level "View traces in Sandbox" pill. Both are constant for the
    // session, so we leave them alone across chat turns.
    appendChatMsg(hist, 'user', txt);
    const historyForServer = state.manualChat.messages.slice();
    state.manualChat.messages.push({ role: 'user', content: txt });
    const def = PROVIDER_DEFS.find(p => p.id === state.manualChat.provider);
    try {
      await consumeSSE(`${BACKEND_URLS[state.backend]}/api/chat/manual`, {
        method: 'POST', headers: chatHeaders(),
        body: JSON.stringify({ message: txt, history: historyForServer, provider: def?.wire, model: state.manualChat.model, projectId: state.projectId || undefined }),
      }, ev => {
        // code-snippet events are ignored — the static snippet is already in
        // place. view_in_sandbox is ignored too — we keep the project-level
        // traces pill from the initial render rather than swapping in a
        // per-trace URL on every turn.
        if (ev.type === 'result') {
          const reply = ev.log || '_(no response)_';
          appendChatMsg(hist, 'bot', reply);
          state.manualChat.messages.push({ role: 'assistant', content: reply });
        } else if (ev.type === 'error') appendChatMsg(hist, 'bot', `_(error: ${ev.error || 'unknown'})_`);
      });
    } catch (err) {
      appendChatMsg(hist, 'bot', `_(${err.message || 'backend unreachable'})_`);
    }
  });
}

// ─── Auto chat ──────────────────────────────────────────────────────────────
function renderAutoSelectors() {
  const provSel = $('#auto-provider-select');
  const modelSel = $('#auto-model-select');
  if (!state.autoChat.provider) {
    const f = pickFirstEnabled();
    if (f) { state.autoChat.provider = f.id; state.autoChat.model = defaultModelFor(f.family); }
  }
  fillProviderSelect(provSel, state.autoChat.provider);
  state.autoChat.provider = provSel.value;
  const def = PROVIDER_DEFS.find(p => p.id === provSel.value);
  state.autoChat.model = fillModelSelect(modelSel, def?.family || 'openai', state.autoChat.model);
  toggleLangchainWarning(def);
  if (state.autoChat.messages.length === 0) {
    renderStaticChatPanel('auto-sdk-panel', 'auto', state.autoChat.provider, state.autoChat.model, 'chat-auto');
  }
}
function toggleLangchainWarning(def) {
  const isLC = def && def.id.startsWith('lc-');
  $('#auto-langchain-warning').classList.toggle('hidden', !(isLC && state.backend === 'python'));
}
function bindAutoSelectors() {
  $('#auto-provider-select').addEventListener('change', e => {
    state.autoChat.provider = e.target.value;
    const def = PROVIDER_DEFS.find(p => p.id === e.target.value);
    state.autoChat.model = defaultModelFor(def?.family || 'openai');
    renderAutoSelectors();
  });
  $('#auto-model-select').addEventListener('change', e => { state.autoChat.model = e.target.value; });
}
function bindAutoChat() {
  $('#auto-chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#auto-chat-input'), txt = input.value.trim();
    if (!txt) return;
    input.value = '';
    const hist = $('#auto-chat-history');
    // SDK panel rendered once on entry — leave it alone across turns.
    appendChatMsg(hist, 'user', txt);
    const historyForServer = state.autoChat.messages.slice();
    state.autoChat.messages.push({ role: 'user', content: txt });
    const def = PROVIDER_DEFS.find(p => p.id === state.autoChat.provider);
    try {
      await consumeSSE(`${BACKEND_URLS[state.backend]}/api/chat/auto`, {
        method: 'POST', headers: chatHeaders(),
        body: JSON.stringify({ message: txt, history: historyForServer, provider: def?.wire, model: state.autoChat.model, projectId: state.projectId || undefined }),
      }, ev => {
        // Same as manual-chat: ignore code-snippet + view_in_sandbox; static
        // panel + project-level pill are already in place.
        if (ev.type === 'result') {
          const reply = ev.log || '_(no response)_';
          appendChatMsg(hist, 'bot', reply);
          state.autoChat.messages.push({ role: 'assistant', content: reply });
        } else if (ev.type === 'error') appendChatMsg(hist, 'bot', `_(error: ${ev.error || 'unknown'})_`);
      });
    } catch (err) {
      appendChatMsg(hist, 'bot', `_(${err.message || 'backend unreachable'})_`);
    }
  });
}

// ─── Workflow runner ────────────────────────────────────────────────────────
function bindWorkflowControls() {
  $('#workflow-rerun').addEventListener('click', () => {
    if (!state.workflow.selected || state.workflow.status === 'running') return;
    state.workflow.phases = WORKFLOWS[state.workflow.selected].phases.map((p, i) => ({
      index: i + 1, title: p.title, what: p.what, why: p.why, status: 'pending', events: [],
    }));
    state.workflow.status = 'idle';
    state.workflow.summaryLink = null;
    state.workflow.activeIndex = null;
    renderWorkflowPlayer();
  });
}


function renderWorkflowPlayer() {
  if (!state.workflow.selected) return;
  // Default to "active" mode; the idle branch below will re-enable wf-mode-idle.
  document.body.classList.remove('wf-mode-idle');
  const wf = WORKFLOWS[state.workflow.selected];
  $('#workflow-title').textContent = wf.title;
  // Use the natural one-liner (no "tethering …" prefix). Hidden via CSS at idle.
  $('#workflow-subtitle').textContent = wf.short || wf.subtitle || '';
  const bc = $('#wf-breadcrumb-leaf');
  if (bc) bc.textContent = wf.title;

  // Resolve which phase is "active" in the UI:
  // 1. user selection (state.workflow.activeIndex), 2. currently running, 3. first pending, 4. first
  let activeIdx = state.workflow.activeIndex;
  if (!activeIdx) {
    const running = state.workflow.phases.find(p => p.status === 'running');
    if (running) activeIdx = running.index;
    else {
      const firstPending = state.workflow.phases.find(p => p.status === 'pending');
      activeIdx = firstPending?.index ?? state.workflow.phases[0]?.index ?? 1;
    }
  }

  // Left rail: phase list
  const list = $('#phase-list');
  list.textContent = '';
  state.workflow.phases.forEach(p => {
    const item = el('button', `wf-phase-item ${p.status} ${p.index === activeIdx ? 'active' : ''}`);
    item.dataset.phaseIndex = String(p.index);
    const icon = el('span', 'wf-phase-icon');
    if (p.status === 'done') icon.textContent = '✓';
    else if (p.status === 'error') icon.textContent = '!';
    else if (p.status === 'running') icon.textContent = '·';
    else icon.textContent = String(p.index);
    item.appendChild(icon);
    item.appendChild(el('span', 'wf-phase-name', `${p.index}. ${p.title}`));
    item.addEventListener('click', () => {
      state.workflow.activeIndex = p.index;
      renderWorkflowPlayer();
    });
    list.appendChild(item);
  });

  // Right pane: active phase detail
  const detail = $('#phase-detail');
  detail.textContent = '';
  const active = state.workflow.phases.find(p => p.index === activeIdx);

  if (state.workflow.status === 'idle' && state.workflow.phases.every(p => p.status === 'pending')) {
    document.body.classList.add('wf-mode-idle');
    const intro = el('div', 'wf-preflight');

    intro.appendChild(el('span', 'wf-preflight-pill', 'PRE-FLIGHT'));
    intro.appendChild(el('h3', 'wf-preflight-title', wf.title));
    intro.appendChild(el('p', 'wf-preflight-sub', wf.short));

    const grid = el('div', 'wf-preflight-grid');
    wf.phases.forEach((p, i) => {
      const cell = el('div', `wf-preflight-row${i === 0 ? ' active' : ''}`);
      cell.appendChild(el('span', 'wf-preflight-num', String(i + 1)));
      const text = el('div', 'wf-preflight-text');
      text.appendChild(el('div', 'wf-preflight-cell-title', p.title));
      cell.appendChild(text);
      grid.appendChild(cell);
    });
    intro.appendChild(grid);

    // LLM-connection prereq note for the 3 workflows that hit LLM evaluators
    // server-side. Without a connection configured under Project Settings,
    // the run completes but every evaluation returns 0 / fails silently.
    if (['dataset-run', 'eval-execution', 'experiment-run'].includes(state.workflow.selected)) {
      const note = el('div', 'wf-preflight-note');
      note.appendChild(el('span', 'wf-preflight-note-icon', '!'));
      note.appendChild(el('span', 'wf-preflight-note-text',
        'Make sure the project has an LLM connection set up for the model — gear icon → Project Settings → LLM connections. Without it this workflow will fail.'));
      intro.appendChild(note);
    }

    // Prompt-compile: user fills in the template variables before we run.
    if (state.workflow.selected === 'prompt-compile') {
      const inputs = el('div', 'wf-prompt-inputs');
      inputs.appendChild(el('p', 'wf-prompt-inputs-label',
        'Fill in the template input variables — these get plugged into the prompt before the LLM call using compile.'));
      const grid = el('div', 'wf-prompt-inputs-grid');

      const fields = [
        { key: 'tone',          label: 'tone',          placeholder: 'empathetic and professional', long: false },
        { key: 'customer_name', label: 'customer_name', placeholder: 'Priya',                       long: false },
        { key: 'issue',         label: 'issue',         placeholder: 'Order #4831 was supposed to arrive yesterday but tracking still says "in transit"…', long: true },
      ];
      const cached = state.promptCompileVars || {};
      fields.forEach(f => {
        const cell = el('div', `wf-prompt-input-cell ${f.long ? 'span-2' : ''}`);
        cell.appendChild(el('label', 'field-label', f.label));
        const input = document.createElement(f.long ? 'textarea' : 'input');
        input.id = `pc-${f.key}-input`;
        input.className = 'key-input';
        input.placeholder = f.placeholder;
        if (f.long) input.rows = 3;
        input.value = cached[f.key] ?? f.placeholder;
        cell.appendChild(input);
        grid.appendChild(cell);
      });
      inputs.appendChild(grid);
      intro.appendChild(inputs);
    }

    const cta = el('div', 'wf-preflight-cta');
    cta.appendChild(el('span', 'wf-preflight-hint', 'Idempotent — re-running won\'t duplicate artifacts on your project.'));
    const runBtn = el('button', 'wf-run-btn');
    runBtn.appendChild(el('span', 'wf-run-icon', '▶'));
    runBtn.appendChild(el('span', '', 'RUN WORKFLOW'));
    runBtn.addEventListener('click', () => {
      if (state.workflow.status === 'running') return;
      if (state.workflow.selected === 'prompt-compile') {
        state.promptCompileVars = {
          tone:          $('#pc-tone-input')?.value?.trim()          || 'empathetic and professional',
          customer_name: $('#pc-customer_name-input')?.value?.trim() || 'Priya',
          issue:         $('#pc-issue-input')?.value?.trim()         || 'Order #4831 was supposed to arrive yesterday but tracking still says "in transit".',
        };
      }
      runWorkflow(state.workflow.selected);
    });
    cta.appendChild(runBtn);
    intro.appendChild(cta);

    detail.appendChild(intro);
  } else if (active) {
    const head = el('div', 'wf-detail-head');
    head.appendChild(el('span', 'wf-detail-head-icon', '◧'));
    const headText = el('div', '');
    headText.appendChild(el('h3', 'wf-detail-title', `${active.index}. ${active.title}`));
    headText.appendChild(el('p', 'wf-detail-what', active.what));
    head.appendChild(headText);
    detail.appendChild(head);

    const events = el('div', 'wf-detail-events');

    // Collapse all code-snippet events for this phase into ONE merged script.
    const codeChunks = (active.events || [])
      .filter(ev => ev.type === 'code-snippet' && ev.code)
      .map(ev => ev.code);
    if (codeChunks.length) {
      const merged = codeChunks.join('\n\n');
      const lastSnippet = (active.events || []).filter(ev => ev.type === 'code-snippet').pop();
      renderSnippet(events, {
        type: 'code-snippet',
        code: merged,
        language: lastSnippet?.language,
        stage: lastSnippet?.stage || 'workflow',
      });
    }

    // Result + error events — show only the latest of each (skip noisy log-notes).
    const lastResult = [...(active.events || [])].reverse().find(ev => ev.type === 'result');
    const errorEv    = (active.events || []).find(ev => ev.type === 'error');
    if (errorEv) appendPhaseEvent(events, errorEv);
    else if (lastResult) {
      // If the result starts with "LLM reply:" render it as a styled output panel.
      const log = String(lastResult.log || '');
      const llmMatch = log.match(/^LLM reply:\s*([\s\S]*)$/);
      if (llmMatch) {
        renderLlmOutput(events, llmMatch[1]);
        attachSandboxLinkInline(events, lastResult.view_in_sandbox);
      } else {
        appendPhaseEvent(events, lastResult);
      }
    }

    if (!codeChunks.length && !lastResult && !errorEv) {
      const placeholder = el('div', 'muted text-sm', active.status === 'running' ? 'Running…' : `Why this matters: ${active.why}`);
      events.appendChild(placeholder);
    }
    detail.appendChild(events);
  }

  // Status bar
  const total = wf.phases.length;
  const running = state.workflow.phases.find(p => p.status === 'running');
  const doneCount = state.workflow.phases.filter(p => p.status === 'done').length;
  const errCount  = state.workflow.phases.filter(p => p.status === 'error').length;
  let progressLabel = 'Sequential runtime ready';
  let statusLabel = '';
  if (state.workflow.status === 'running') {
    progressLabel = running ? `Running phase ${running.index} of ${total}` : `Running…`;
    statusLabel = `${doneCount} done · ${total - doneCount - (running ? 1 : 0)} pending`;
  } else if (state.workflow.status === 'done') {
    progressLabel = `Complete · ${doneCount} of ${total} phases`;
    if (errCount) statusLabel = `${errCount} failed`;
  } else if (state.workflow.status === 'error') {
    progressLabel = 'Run failed';
    statusLabel = `${errCount} failed`;
  }
  $('#workflow-progress').textContent = progressLabel;
  $('#workflow-foot-status').textContent = statusLabel;

  // Run-again button is disabled while running and while idle (nothing to redo)
  $('#workflow-rerun').disabled = state.workflow.status === 'running' || state.workflow.status === 'idle';

  const summaryEl = $('#workflow-summary');
  if (state.workflow.status === 'done') {
    summaryEl.classList.remove('hidden');
    const det = $('#workflow-summary-details');
    det.textContent = '';
    det.appendChild(el('span', '', `${wf.title} — ${doneCount} of ${total} steps executed.`));
    if (state.workflow.summaryLink) {
      const a = document.createElement('a');
      a.href = state.workflow.summaryLink.url; a.target = '_blank'; a.rel = 'noopener';
      a.className = 'wf-summary-link';
      a.textContent = (state.workflow.summaryLink.label || 'View in Sandbox') + ' ↗';
      det.appendChild(a);
    }
  } else {
    summaryEl.classList.add('hidden');
  }
}

function appendPhaseEvent(panel, ev) {
  if (ev.type === 'code-snippet') {
    renderSnippet(panel, ev);
    if (ev.log) panel.appendChild(el('div', 'log-note', ev.log));
  } else if (ev.type === 'result') {
    const line = el('div', 'phase-result-line', ev.log || 'Done');
    panel.appendChild(line);
    if (ev.view_in_sandbox && ev.view_in_sandbox.url) {
      const a = document.createElement('a');
      a.href = ev.view_in_sandbox.url; a.target = '_blank'; a.rel = 'noopener';
      a.className = 'view-in-sandbox-btn';
      a.textContent = ev.view_in_sandbox.label || 'View in Sandbox';
      panel.appendChild(a);
    }
  } else if (ev.type === 'error') {
    panel.appendChild(el('div', 'phase-result-line error', `Error: ${ev.error || 'unknown'}`));
  } else if (ev.type === 'log') {
    panel.appendChild(el('div', 'log-note', ev.log));
  }
}

async function runWorkflow(name) {
  state.workflow.status = 'running';
  state.workflow.summaryLink = null;
  let activePhase = null;
  renderWorkflowPlayer();
  const payload = { projectId: state.projectId || 'unknown-project' };
  if (name === 'prompt-compile' && state.promptCompileVars) {
    payload.vars = state.promptCompileVars;
  }
  try {
    await consumeSSE(`${BACKEND_URLS[state.backend]}/api/workflows/${name}`, {
      method: 'POST', headers: chatHeaders(),
      body: JSON.stringify(payload),
    }, (ev) => {
      if (ev.type === 'phase-start') {
        const p = state.workflow.phases.find(x => x.index === ev.phase_index);
        if (p) {
          p.status = 'running';
          activePhase = p;
          // Auto-follow the running phase in the right pane
          state.workflow.activeIndex = p.index;
        }
      } else if (['code-snippet', 'result', 'error', 'log'].includes(ev.type)) {
        const p = state.workflow.phases.find(x => x.index === ev.phase_index) || activePhase;
        if (p) {
          p.events = p.events || [];
          p.events.push(ev);
          if (ev.view_in_sandbox && ev.view_in_sandbox.url) state.workflow.summaryLink = ev.view_in_sandbox;
        }
      } else if (ev.type === 'phase-end') {
        const p = state.workflow.phases.find(x => x.index === ev.phase_index) || activePhase;
        if (p) p.status = (p.events || []).some(e => e.type === 'error') ? 'error' : 'done';
      } else if (ev.type === 'done') {
        state.workflow.status = 'done';
      }
      renderWorkflowPlayer();
    });
  } catch (err) {
    state.workflow.status = 'error';
    if (activePhase) activePhase.status = 'error';
    console.error('workflow stream failed', err);
    renderWorkflowPlayer();
  }
}

// ─── SSE consumer ───────────────────────────────────────────────────────────
async function consumeSSE(url, opts, onEvent) {
  const r = await fetch(url, opts);
  if (!r.ok || !r.body) throw new Error(`SSE request failed: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      if (!dataLines.length) continue;
      try { onEvent(JSON.parse(dataLines.join('\n'))); } catch { /* parse error */ }
    }
  }
}

// ─── Snippet rendering ──────────────────────────────────────────────────────
function snippetFilename(lang, stage) {
  const ext = lang === 'typescript' ? 'ts' : 'py';
  if (stage === 'auth')        return `auth.${ext}`;
  if (stage === 'chat-manual') return `manual_trace.${ext}`;
  if (stage === 'chat-auto')   return `auto_trace.${ext}`;
  return `setup.${ext}`;
}
function renderSnippet(panel, event) {
  if (!event || event.type !== 'code-snippet' || !event.code) return;
  const lang = event.language === 'typescript' ? 'typescript' : 'python';
  const block = el('div', 'snippet-block');

  const titlebar = el('div', 'snippet-titlebar');
  const left = el('div', 'snippet-titlebar-left');
  const dots = el('span', 'snippet-dots');
  dots.appendChild(el('span', 'snippet-dot snippet-dot-red'));
  dots.appendChild(el('span', 'snippet-dot snippet-dot-yellow'));
  dots.appendChild(el('span', 'snippet-dot snippet-dot-green'));
  left.appendChild(dots);
  left.appendChild(el('span', 'snippet-filename', snippetFilename(lang, event.stage)));
  titlebar.appendChild(left);

  const copy = el('button', 'snippet-copy', 'Copy');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(event.code);
    const t = $('#toast'); t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 1200);
  });
  titlebar.appendChild(copy);
  block.appendChild(titlebar);

  if (event.log_text) block.appendChild(el('div', 'log-text', event.log_text));

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = `language-${lang}`;
  code.textContent = event.code;
  pre.appendChild(code);
  block.appendChild(pre);
  panel.appendChild(block);
  if (window.Prism) Prism.highlightElement(code);
}

function renderLlmOutput(panel, text) {
  const block = el('div', 'llm-output-block');

  const titlebar = el('div', 'llm-output-titlebar');
  const left = el('div', 'llm-output-titlebar-left');
  left.appendChild(el('span', 'llm-output-glyph', '✦'));
  left.appendChild(el('span', 'llm-output-label', 'LLM RESPONSE'));
  titlebar.appendChild(left);

  const copy = el('button', 'snippet-copy', 'Copy');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(text);
    const t = $('#toast'); t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 1200);
  });
  titlebar.appendChild(copy);
  block.appendChild(titlebar);

  const body = el('div', 'llm-output-body');
  if (window.marked) body.insertAdjacentHTML('beforeend', marked.parse(text));
  else body.textContent = text;
  block.appendChild(body);

  panel.appendChild(block);
}

function attachSandboxLinkInline(panel, vis) {
  if (!vis || !vis.url) return;
  const a = document.createElement('a');
  a.href = vis.url; a.target = '_blank'; a.rel = 'noopener';
  a.className = 'view-in-sandbox-btn';
  a.textContent = (vis.label || 'View in Sandbox') + ' ↗';
  panel.appendChild(a);
}

function attachSandboxLink(panel, vis) {
  // For Stage 3/4 we prefer the project-level traces page (logs/traces). The
  // chat view always shows a project-level link, regardless of whether a chat
  // has been sent — per the user's spec.
  const card = panel.closest('.card') || panel;
  card.classList.add('has-sticky-cta');
  let pill = card.querySelector('.sticky-trace-cta');
  if (!pill) {
    pill = document.createElement('a');
    pill.className = 'sticky-trace-cta';
    pill.target = '_blank';
    pill.rel = 'noopener';
    card.appendChild(pill);
  }
  // For chat panels (manual/auto SDK panels) always point at the project-level
  // /logs/traces page so the user lands on the project log view, not a single
  // trace.
  const isChatPanel = panel.id === 'manual-sdk-panel' || panel.id === 'auto-sdk-panel';
  const projectUrl = projectTracesUrl();
  if (isChatPanel && projectUrl) {
    pill.href = projectUrl;
    pill.textContent = 'View traces in Sandbox';
    return;
  }
  if (!vis || !vis.url) {
    if (projectUrl) {
      pill.href = projectUrl;
      pill.textContent = 'View traces in Sandbox';
    } else {
      pill.remove();
      card.classList.remove('has-sticky-cta');
    }
    return;
  }
  pill.href = vis.url;
  pill.textContent = vis.label || 'View in Sandbox';
}

function clearStickyTraceCta(panel) {
  // Don't actually clear — we always want the project-level traces link
  // visible on chat panels. Re-attach it to the project URL.
  const isChatPanel = panel.id === 'manual-sdk-panel' || panel.id === 'auto-sdk-panel';
  if (isChatPanel) {
    attachSandboxLink(panel, null);
    return;
  }
  const card = panel.closest('.card') || panel;
  const pill = card.querySelector('.sticky-trace-cta');
  if (pill) pill.remove();
  card.classList.remove('has-sticky-cta');
}

// ─── Sidebar wiring ─────────────────────────────────────────────────────────
function bindSidebar() {
  $$('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.classList.contains('locked')) return;
      navigate(item.dataset.route);
    });
  });
}

// ─── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindSidebar();
  bindConnect();
  bindManualSelectors();
  bindManualChat();
  bindAutoSelectors();
  bindAutoChat();
  bindWorkflowControls();
  // If session has cached auth + a non-connect route, drop them on connect view first; the auth gate is on the route, not the session.
  if (!state.authed) state.route = 'connect';
  render();
});

export { state, renderSnippet };
