# Agentic Debate UI

A multi-agent AI debate system where configurable LLM agents debate a question over multiple rounds until they converge on the best answer.

## Features

- Multiple agents debating the same problem
- Different LLM models per agent
- Async parallel backend execution per round
- Curated model dropdowns for OpenAI, Anthropic, and Gemini
- Streaming round-by-round updates
- Built-in presets:
  - Code Review Council
  - Trading Strategy Review
- Save/load custom presets in browser localStorage
- Polished React + Tailwind UI
- FastAPI backend

---

## Project structure

- `backend/` - FastAPI orchestration API
- `frontend/` - React/Vite/Tailwind UI

---

## Backend setup

```bash
cd backend
uv sync
cp .env.example .env
uv run uvicorn api:app --reload
```

Backend runs at:

```bash
http://127.0.0.1:8000
```

Health check:

```bash
http://127.0.0.1:8000/health
```

---

## Frontend setup

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Frontend runs at:

```bash
http://localhost:5173
```

---

## Environment variables

Backend:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY` or `GOOGLE_API_KEY`, depending on your LiteLLM config

Frontend:
- `VITE_API_URL=http://127.0.0.1:8000`

---

## Notes

### Async parallel execution
All agents in the same debate round are executed concurrently on the backend with `asyncio.gather(...)`.

### Gemini model aliases
Depending on your LiteLLM setup, Gemini aliases may differ.

Examples:
- `gemini/gemini-1.5-pro`
- `vertex_ai/gemini-1.5-pro`

If needed, update:
- `frontend/src/lib/models.js`
- `frontend/src/lib/presets.js`

### Convergence
Consensus means the agents reached stable agreement under the debate protocol. It does not guarantee truth.

---

## API endpoints

### POST `/debate`
Runs the full debate and returns the final result.

### POST `/debate/stream`
Streams debate progress round by round using SSE-style chunks over fetch streaming.

### GET `/health`
Simple health/configuration check.

---

## License

MIT
