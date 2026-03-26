# Agora

A multi-agent AI system where configurable LLM agents collaborate to produce the best answer — through structured debate or phased analysis.

## Features

- **Two workflow modes**:
  - **Debate** — agents argue over multiple rounds until they converge on the strongest answer
  - **Analysis** — agents work through three structured phases (Clarify, Research, Challenge) to build a rigorous answer
- Multiple agents with independent LLM models, system prompts, and configurations
- Per-agent settings: thinking mode, reasoning effort, web search, temperature
- Async parallel execution per round/phase
- Streaming round-by-round or phase-by-phase updates via SSE
- Convergence detection with configurable consensus threshold
- Neutral synthesizer model produces the final answer
- Markdown export of results
- Built-in presets:
  - Code Review Council (debate)
  - Trading Strategy Review (debate)
  - General Analysis (analysis)
- Save/load custom presets in browser localStorage
- React + Tailwind UI, FastAPI backend
- Direct provider SDKs for OpenAI, Anthropic, and Google Gemini

---

## Supported models

| Provider | Models |
|----------|--------|
| OpenAI | gpt-5.4, gpt-5-mini |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001 |
| Gemini | gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.1-flash-lite-preview |

Models are configured per-agent using the `provider/model-name` format (e.g., `anthropic/claude-sonnet-4-6`).

---

## Project structure

- `backend/` — FastAPI orchestration API
- `frontend/` — React/Vite/Tailwind UI

---

## Backend setup

```bash
cp .env.example .env
cd backend
uv sync
uv run uvicorn api:app --reload
```

Backend runs at `http://127.0.0.1:8001`.

Health check: `GET http://127.0.0.1:8001/health`

---

## Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5173`.

---

## Environment variables

Single repo-root `.env`:

| Variable | Required | Notes |
|----------|----------|-------|
| `OPENAI_API_KEY` | For OpenAI models | |
| `ANTHROPIC_API_KEY` | For Anthropic models | |
| `GEMINI_API_KEY` | For Gemini models | Also accepts `GOOGLE_API_KEY` |
| `VITE_API_URL` | Yes | Default: `http://127.0.0.1:8001` |

---

## Per-agent configuration

Each agent supports:

| Setting | Description | Default |
|---------|-------------|---------|
| `model` | Provider/model identifier | — |
| `system_prompt` | Custom instructions for the agent's role | Generic expert prompt |
| `temperature` | Sampling temperature (0.0–1.0) | 0.3 |
| `use_thinking` | Enable extended thinking / reasoning | false |
| `thinking_budget` | Max tokens for internal reasoning | 16000 |
| `reasoning_effort` | Reasoning depth: low, medium, high | medium |
| `use_web_search` | Allow the agent to search the web | false |

---

## API endpoints

### POST `/debate`

Runs the full workflow and returns the final result.

Accepts `workflow_mode`: `"debate"` (default) or `"analysis"`.

### POST `/debate/stream`

Streams progress using SSE-style chunks over fetch streaming.

Same `workflow_mode` parameter for debate or analysis.

### GET `/health`

Health and configuration check.

---

## How it works

### Debate mode

1. All agents independently answer the question (round 1)
2. In subsequent rounds, agents see all previous answers and a support tally
3. Agents revise their positions, critique others, and shift support
4. The debate ends when consensus is stable or max rounds are reached
5. A synthesizer model produces the final answer

### Analysis mode

1. **Clarify** — frame the question, surface assumptions, draft initial answers
2. **Research** — strengthen with evidence, examples, and base rates
3. **Challenge** — pressure-test the strongest answer, attack weak assumptions

All agents run in parallel within each phase. A synthesizer produces the final answer with uncertainties, alternatives, and follow-ups.

### Convergence

Consensus means the agents reached stable agreement under the protocol. It does not guarantee truth.

---

## License

MIT
