from __future__ import annotations

import asyncio
import json
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import anthropic
import openai
from google import genai
from google.genai import types


@dataclass
class AgentConfig:
    name: str
    model: str
    system_prompt: str = (
        "You are a rigorous expert participating in a collaborative debate. "
        "Your goal is to improve the group's answer, not defend your ego. "
        "If another agent has a better answer, acknowledge it."
    )
    temperature: float = 0.3
    use_thinking: bool = False
    thinking_budget: int = 16000
    reasoning_effort: str = "medium"
    use_web_search: bool = False


@dataclass
class AgentTurn:
    agent: str
    round_num: int
    answer: str
    reasoning: List[str] = field(default_factory=list)
    critiques: List[Dict[str, str]] = field(default_factory=list)
    confidence: float = 0.5
    support_for: str = ""
    changed_mind: bool = False
    raw: str = ""


def extract_json(text: str) -> Dict[str, Any]:
    text = str(text).strip()
    text = re.sub(
        r"^```(?:json)?\s*|\s*```$",
        "",
        text,
        flags=re.IGNORECASE | re.MULTILINE,
    ).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def normalize_turn(
    data: Dict[str, Any],
    *,
    agent_name: str,
    round_num: int,
    raw: str,
    valid_agents: List[str],
) -> AgentTurn:
    answer = str(data.get("answer") or raw).strip()

    reasoning = data.get("reasoning", [])
    if isinstance(reasoning, str):
        reasoning = [reasoning]
    reasoning = [str(x).strip() for x in reasoning if str(x).strip()]

    critiques = data.get("critiques", [])
    normalized_critiques = []
    if isinstance(critiques, list):
        for item in critiques:
            if isinstance(item, dict):
                target = str(item.get("target", "unknown")).strip() or "unknown"
                critique = str(item.get("critique", "")).strip()
                if critique:
                    normalized_critiques.append({"target": target, "critique": critique})
            elif isinstance(item, str) and item.strip():
                normalized_critiques.append({"target": "unknown", "critique": item.strip()})

    try:
        confidence = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    support_for = str(data.get("support_for") or agent_name).strip()
    if support_for not in valid_agents:
        support_for = agent_name

    changed_mind = bool(data.get("changed_mind", False))

    return AgentTurn(
        agent=agent_name,
        round_num=round_num,
        answer=answer,
        reasoning=reasoning,
        critiques=normalized_critiques,
        confidence=confidence,
        support_for=support_for,
        changed_mind=changed_mind,
        raw=raw,
    )


class LLMAgent:
    def __init__(self, config: AgentConfig):
        self.config = config

    def _anthropic_thinking(self) -> Optional[Dict[str, str]]:
        if not getattr(self.config, "use_thinking", False):
            return None
        # Anthropic's current SDK deprecates fixed-budget "enabled" thinking for Claude 4.6.
        return {"type": "adaptive"}

    def _gemini_thinking_config(self, model_name: str) -> Optional[types.ThinkingConfig]:
        if not getattr(self.config, "use_thinking", False):
            return None

        if model_name == "gemini-3.1-flash-lite-preview":
            return types.ThinkingConfig(thinking_level="MINIMAL")

        return types.ThinkingConfig(
            thinking_budget=getattr(self.config, "thinking_budget", 16000),
        )

    async def act(
        self,
        *,
        question: str,
        round_num: int,
        agent_names: List[str],
        prev_round: Optional[List[AgentTurn]] = None,
        prev_support_tally: Optional[Counter] = None,
    ) -> AgentTurn:
        base_system = f"""\
{self.config.system_prompt}

You are in a structured multi-agent debate.
Output ONLY valid JSON with this exact shape:

{{
  "answer": "your current best answer",
  "reasoning": ["short point 1", "short point 2"],
  "critiques": [{{"target": "agent-2", "critique": "specific weakness"}}],
  "confidence": 0.0,
  "support_for": "{self.config.name}",
  "changed_mind": false
}}

Rules:
- confidence must be between 0 and 1
- support_for must be one of: {agent_names}
- be intellectually honest
- if another agent is better, support them
- no markdown
- no code fences
- JSON only
"""

        if not prev_round:
            user_prompt = f"""\
Question:
{question}

Round: {round_num}
Your agent name: {self.config.name}

There are no previous answers yet.
Provide your independent best answer.
Set support_for to your own name for round 1.
Set changed_mind to false for round 1.
"""
        else:
            prev_text = self._format_prev_round(prev_round, prev_support_tally or Counter())
            user_prompt = f"""\
Question:
{question}

Round: {round_num}
Your agent name: {self.config.name}

Previous round:
{prev_text}

Task:
1. Review the previous answers.
2. Revise your answer if you were persuaded.
3. Critique the weakest ideas.
4. Set support_for to the agent whose previous-round position you currently think is strongest.
5. Set changed_mind to true if your answer materially changed.
"""

        provider = self.config.model.split("/")[0] if "/" in self.config.model else "openai"
        model_name = self.config.model.split("/", 1)[1] if "/" in self.config.model else self.config.model

        raw = None
        if provider == "anthropic":
            client = anthropic.AsyncAnthropic()
            kwargs = {
                "model": model_name,
                "messages": [{"role": "user", "content": user_prompt}],
                "system": base_system,
                "temperature": self.config.temperature,
                "max_tokens": 8192,
            }
            thinking = self._anthropic_thinking()
            if thinking:
                kwargs["thinking"] = thinking
            if getattr(self.config, "use_web_search", False):
                kwargs["tools"] = [{
                    "name": "web_search",
                    "type": "web_search_20250305",
                    "user_location": {"type": "approximate", "timezone": "America/New_York"}
                }]
            response = await client.messages.create(**kwargs)
            # Find the text block since reasoning block might exist
            text_blocks = [b.text for b in response.content if getattr(b, "type", "") == "text"]
            raw = text_blocks[0] if text_blocks else str(response.content)

        elif provider == "openai":
            client = openai.AsyncOpenAI()
            if "gpt-5" in model_name:
                kwargs = {
                    "model": model_name,
                    "input": [
                        {"role": "system", "content": base_system},
                        {"role": "user", "content": user_prompt}
                    ],
                    "text": {"format": {"type": "text"}, "verbosity": "medium"}
                }
                if getattr(self.config, "use_thinking", False):
                    kwargs["reasoning"] = {
                        "effort": getattr(self.config, "reasoning_effort", "medium")
                    }
                if getattr(self.config, "use_web_search", False):
                    kwargs["tools"] = [{
                        "type": "web_search",
                        "user_location": {"type": "approximate", "timezone": "America/New_York"},
                        "search_context_size": "medium"
                    }]
                response = await client.responses.create(**kwargs)
                # In new API, raw text sits inside output content parts
                raw_extracted = None
                if hasattr(response, "output"):
                    for item in response.output:
                        if type(item).__name__ == "ResponseOutputMessage" and hasattr(item, "content"):
                            for block in item.content:
                                if type(block).__name__ == "ResponseOutputText" and hasattr(block, "text"):
                                    raw_extracted = block.text
                                    break
                            if raw_extracted:
                                break
                raw = raw_extracted if raw_extracted else str(response)
            else:
                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": base_system},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=self.config.temperature,
                )
                raw = response.choices[0].message.content

        elif provider == "gemini":
            import os
            api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
            client = genai.Client(api_key=api_key)
            config = types.GenerateContentConfig(
                system_instruction=base_system,
                temperature=self.config.temperature,
            )
            thinking_config = self._gemini_thinking_config(model_name)
            if thinking_config:
                config.thinking_config = thinking_config
            if getattr(self.config, "use_web_search", False):
                config.tools = [{"google_search": {}}]
            
            gemini_contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=user_prompt),
                    ],
                ),
            ]

            response = await client.aio.models.generate_content(
                model=model_name,
                contents=gemini_contents,
                config=config
            )
            raw = response.text
        else:
            raise ValueError(f"Provider {provider} not supported.")
        if not isinstance(raw, str):
            raw = json.dumps(raw, ensure_ascii=False)

        try:
            data = extract_json(raw)
        except Exception:
            data = {
                "answer": raw,
                "reasoning": [],
                "critiques": [],
                "confidence": 0.5,
                "support_for": self.config.name,
                "changed_mind": False,
            }

        turn = normalize_turn(
            data,
            agent_name=self.config.name,
            round_num=round_num,
            raw=raw,
            valid_agents=agent_names,
        )

        if round_num == 1:
            turn.support_for = self.config.name
            turn.changed_mind = False

        return turn

    @staticmethod
    def _format_prev_round(prev_round: List[AgentTurn], support_tally: Counter) -> str:
        blocks = []
        for turn in prev_round:
            critiques_text = json.dumps(turn.critiques, ensure_ascii=False)
            reasoning_text = "; ".join(turn.reasoning) if turn.reasoning else "n/a"
            blocks.append(
                f"""\
[{turn.agent}]
answer: {turn.answer}
reasoning: {reasoning_text}
confidence: {turn.confidence:.2f}
supporters: {support_tally.get(turn.agent, 0)}
changed_mind: {turn.changed_mind}
critiques: {critiques_text}"""
            )
        return "\n\n".join(blocks)


class DebateOrchestrator:
    def __init__(
        self,
        *,
        agents: List[AgentConfig],
        max_rounds: int = 5,
        consensus_threshold: float = 0.67,
        stable_rounds: int = 2,
        synthesizer_model: Optional[str] = None,
        synthesizer_temperature: float = 0.2,
        max_concurrent_agents: Optional[int] = None,
    ):
        if len(agents) < 2:
            raise ValueError("You need at least 2 agents for a debate.")

        self.agent_wrappers = [LLMAgent(a) for a in agents]
        self.max_rounds = max_rounds
        self.consensus_threshold = consensus_threshold
        self.stable_rounds = stable_rounds
        self.synthesizer_model = synthesizer_model
        self.synthesizer_temperature = synthesizer_temperature
        self.max_concurrent_agents = max_concurrent_agents or len(agents)

    async def run(self, question: str) -> Dict[str, Any]:
        final_result = None
        async for event in self.run_stream(question):
            if event["type"] == "final":
                final_result = event["result"]

        if final_result is None:
            raise RuntimeError("Debate did not produce a final result.")

        return final_result

    async def run_stream(self, question: str) -> AsyncIterator[Dict[str, Any]]:
        history: List[List[AgentTurn]] = []
        last_leader: Optional[str] = None
        leader_streak = 0
        converged = False
        final_support = Counter()
        semaphore = asyncio.Semaphore(self.max_concurrent_agents)

        agent_names = [a.config.name for a in self.agent_wrappers]

        yield {
            "type": "start",
            "question": question,
            "agent_names": agent_names,
            "max_rounds": self.max_rounds,
        }

        for round_num in range(1, self.max_rounds + 1):
            yield {"type": "round_started", "round_num": round_num}

            prev_round = history[-1] if history else None
            prev_support_tally = Counter(t.support_for for t in prev_round) if prev_round else Counter()

            async def run_one(agent: LLMAgent) -> AgentTurn:
                async with semaphore:
                    return await agent.act(
                        question=question,
                        round_num=round_num,
                        agent_names=agent_names,
                        prev_round=prev_round,
                        prev_support_tally=prev_support_tally,
                    )

            results = await asyncio.gather(
                *(run_one(agent) for agent in self.agent_wrappers),
                return_exceptions=True,
            )

            turns: List[AgentTurn] = []
            for agent, result in zip(self.agent_wrappers, results):
                if isinstance(result, Exception):
                    turns.append(self._failed_turn(agent.config.name, round_num, str(result)))
                else:
                    turns.append(result)

            history.append(turns)

            current_support = Counter(t.support_for for t in turns)
            final_support = current_support

            leader, votes = current_support.most_common(1)[0]
            ratio = votes / len(turns)

            if round_num > 1 and ratio >= self.consensus_threshold:
                if leader == last_leader:
                    leader_streak += 1
                else:
                    leader_streak = 1

                if leader_streak >= self.stable_rounds:
                    converged = True
            else:
                leader_streak = 0

            last_leader = leader

            yield {
                "type": "round_completed",
                "round_num": round_num,
                "leader": leader,
                "ratio": ratio,
                "support_tally": dict(current_support),
                "converged_candidate": ratio >= self.consensus_threshold,
                "turns": [asdict(t) for t in turns],
            }

            if converged:
                break

        result = await self._build_result(
            question=question,
            history=history,
            last_leader=last_leader,
            converged=converged,
            final_support=final_support,
        )

        yield {
            "type": "final",
            "result": result,
        }

    async def _build_result(
        self,
        *,
        question: str,
        history: List[List[AgentTurn]],
        last_leader: Optional[str],
        converged: bool,
        final_support: Counter,
    ) -> Dict[str, Any]:
        leader = last_leader or history[-1][0].agent
        final_answer = await self._synthesize(question, history, leader, converged, final_support)

        return {
            "question": question,
            "converged": converged,
            "rounds_run": len(history),
            "leader": leader,
            "support_tally": dict(final_support),
            "final_answer": final_answer,
            "transcript": [[asdict(t) for t in round_turns] for round_turns in history],
        }

    async def _synthesize(
        self,
        question: str,
        history: List[List[AgentTurn]],
        leader: str,
        converged: bool,
        support_tally: Counter,
    ) -> str:
        latest_round = history[-1]
        winner_turn = next((t for t in latest_round if t.agent == leader), latest_round[0])

        if not self.synthesizer_model:
            return winner_turn.answer

        transcript_text = self._format_history(history)
        
        provider = self.synthesizer_model.split("/")[0] if "/" in self.synthesizer_model else "openai"
        model_name = self.synthesizer_model.split("/", 1)[1] if "/" in self.synthesizer_model else self.synthesizer_model

        system_prompt = (
            "You are a neutral moderator. Synthesize the best final answer from the debate. "
            "Prefer the converged position if convergence occurred, but preserve important caveats."
        )
        user_prompt = f"""\
Question:
{question}

Converged: {converged}
Leader: {leader}
Support tally in final round: {dict(support_tally)}

Debate transcript:
{transcript_text}

Write:
1. Final answer
2. Why this answer won
3. Key caveats or assumptions
"""

        if provider == "anthropic":
            client = anthropic.AsyncAnthropic()
            response = await client.messages.create(
                model=model_name,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
                temperature=self.synthesizer_temperature,
                max_tokens=8192,
            )
            content = response.content[0].text if response.content else ""
        elif provider == "openai":
            client = openai.AsyncOpenAI()
            if "gpt-5" in model_name:
                response = await client.responses.create(
                    model=model_name,
                    input=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    text={"format": {"type": "text"}, "verbosity": "medium"}
                )
                content_extracted = None
                if hasattr(response, "output"):
                    for item in response.output:
                        if type(item).__name__ == "ResponseOutputMessage" and hasattr(item, "content"):
                            for block in item.content:
                                if type(block).__name__ == "ResponseOutputText" and hasattr(block, "text"):
                                    content_extracted = block.text
                                    break
                            if content_extracted:
                                break
                content = content_extracted if content_extracted else str(response)
            else:
                response = await client.chat.completions.create(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    temperature=self.synthesizer_temperature,
                )
                content = response.choices[0].message.content
        elif provider == "gemini":
            import os
            api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
            client = genai.Client(api_key=api_key)
            config = types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=self.synthesizer_temperature,
            )
            gemini_contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=user_prompt),
                    ],
                ),
            ]
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=gemini_contents,
                config=config
            )
            content = response.text
        else:
            raise ValueError(f"Provider {provider} not supported.")

        return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)

    @staticmethod
    def _failed_turn(agent_name: str, round_num: int, error_message: str) -> AgentTurn:
        return AgentTurn(
            agent=agent_name,
            round_num=round_num,
            answer=f"Agent failed this round: {error_message}",
            reasoning=["The model call failed, so no substantive answer was produced this round."],
            critiques=[],
            confidence=0.0,
            support_for=agent_name,
            changed_mind=False,
            raw=error_message,
        )

    @staticmethod
    def _format_history(history: List[List[AgentTurn]]) -> str:
        chunks = []
        for i, round_turns in enumerate(history, start=1):
            support = Counter(t.support_for for t in round_turns)
            chunks.append(f"=== ROUND {i} ===")
            for t in round_turns:
                chunks.append(
                    f"""\
Agent: {t.agent}
Support for: {t.support_for}
Confidence: {t.confidence:.2f}
Changed mind: {t.changed_mind}
Answer: {t.answer}
Reasoning: {"; ".join(t.reasoning) if t.reasoning else "n/a"}
Critiques: {json.dumps(t.critiques, ensure_ascii=False)}
"""
                )
            chunks.append(f"Round support tally: {dict(support)}\n")
        return "\n".join(chunks)
