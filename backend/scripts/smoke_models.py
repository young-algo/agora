from __future__ import annotations

import argparse
import asyncio
import re
import sys
from pathlib import Path

from dotenv import load_dotenv


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_MODELS_FILE = REPO_ROOT / "frontend" / "src" / "lib" / "models.js"
THINKING_UNSUPPORTED_MODELS = {
    "anthropic/claude-haiku-4-5-20251001",
}
sys.path.insert(0, str(REPO_ROOT / "backend"))

from debate_system import AgentConfig, LLMAgent


def load_project_env() -> None:
    env_path = REPO_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=False)


def load_curated_models() -> list[str]:
    text = FRONTEND_MODELS_FILE.read_text(encoding="utf-8")
    return re.findall(r'value:\s*"([^"]+)"', text)


def build_agent_config(model: str, use_thinking: bool) -> AgentConfig:
    provider = model.split("/", 1)[0] if "/" in model else "openai"

    kwargs = {
        "name": f"{provider}-{'thinking' if use_thinking else 'standard'}",
        "model": model,
        "temperature": 0.3,
        "use_thinking": use_thinking,
        "thinking_budget": 2048,
        "reasoning_effort": "medium",
    }

    return AgentConfig(**kwargs)


async def run_case(model: str, use_thinking: bool, timeout: float) -> tuple[bool, str]:
    config = build_agent_config(model, use_thinking)
    mode = "thinking" if use_thinking else "standard"

    try:
        turn = await asyncio.wait_for(
            LLMAgent(config).act(
                question="Answer in the required JSON format only: is 2+2 equal to 4?",
                round_num=1,
                agent_names=[config.name],
                prev_round=None,
                prev_support_tally=None,
            ),
            timeout=timeout,
        )
        summary = turn.answer.replace("\n", " ").strip()[:120]
        return True, f"[ok] {model} {mode}: {summary}"
    except Exception as exc:
        return False, f"[err] {model} {mode}: {type(exc).__name__}: {exc}"


async def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test curated Agora models.")
    parser.add_argument(
        "--providers",
        nargs="*",
        choices=["openai", "anthropic", "gemini"],
        help="Optional provider filter.",
    )
    parser.add_argument(
        "--modes",
        nargs="*",
        choices=["standard", "thinking"],
        default=["standard", "thinking"],
        help="Modes to test.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="Per-call timeout in seconds.",
    )
    args = parser.parse_args()

    load_project_env()

    models = load_curated_models()
    if args.providers:
        models = [model for model in models if model.split("/", 1)[0] in set(args.providers)]

    if not models:
        print("No curated models matched the requested filters.", file=sys.stderr)
        return 2

    failed = False
    for model in models:
        for mode in args.modes:
            if mode == "thinking" and model in THINKING_UNSUPPORTED_MODELS:
                print(f"[skip] {model} thinking: unsupported by provider", flush=True)
                continue
            ok, message = await run_case(model, mode == "thinking", args.timeout)
            print(message, flush=True)
            failed = failed or not ok

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
