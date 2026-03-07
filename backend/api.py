import json
import os
from pathlib import Path
from typing import List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from debate_system import AgentConfig, AnalysisOrchestrator, DebateOrchestrator

def load_project_env() -> None:
    backend_dir = Path(__file__).resolve().parent
    env_path = backend_dir.parent / ".env"
    if env_path.exists():
        load_dotenv(dotenv_path=env_path, override=False)


load_project_env()

app = FastAPI(title="Multi-Agent Debate API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AgentSpec(BaseModel):
    name: str
    model: str
    system_prompt: str = "You are a helpful expert."
    temperature: float = 0.3
    use_thinking: bool = False
    thinking_budget: int = 16000
    reasoning_effort: str = "medium"
    use_web_search: bool = False


class DebateRequest(BaseModel):
    question: str
    agents: List[AgentSpec]
    workflow_mode: Literal["debate", "analysis"] = "debate"
    max_rounds: int = 5
    consensus_threshold: float = Field(default=0.67, ge=0.0, le=1.0)
    stable_rounds: int = 2
    synthesizer_model: Optional[str] = None
    synthesizer_temperature: float = 0.2
    max_concurrent_agents: Optional[int] = None


def build_orchestrator(req: DebateRequest):
    common_kwargs = {
        "agents": [AgentConfig(**a.model_dump()) for a in req.agents],
        "synthesizer_model": req.synthesizer_model,
        "synthesizer_temperature": req.synthesizer_temperature,
        "max_concurrent_agents": req.max_concurrent_agents,
    }
    if req.workflow_mode == "analysis":
        return AnalysisOrchestrator(**common_kwargs)

    return DebateOrchestrator(
        agents=common_kwargs["agents"],
        max_rounds=req.max_rounds,
        consensus_threshold=req.consensus_threshold,
        stable_rounds=req.stable_rounds,
        synthesizer_model=common_kwargs["synthesizer_model"],
        synthesizer_temperature=common_kwargs["synthesizer_temperature"],
        max_concurrent_agents=common_kwargs["max_concurrent_agents"],
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
        "anthropic_configured": bool(os.getenv("ANTHROPIC_API_KEY")),
        "gemini_configured": bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")),
    }


@app.post("/debate")
async def debate(req: DebateRequest):
    orchestrator = build_orchestrator(req)
    return await orchestrator.run(req.question)


def sse_event(event_name: str, payload: dict) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/debate/stream")
async def debate_stream(req: DebateRequest):
    orchestrator = build_orchestrator(req)

    async def event_generator():
        try:
            async for event in orchestrator.run_stream(req.question):
                event_name = event.get("type", "message")
                payload = {k: v for k, v in event.items() if k != "type"}
                yield sse_event(event_name, payload)
        except Exception as e:
            yield sse_event("error", {"message": str(e)})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
