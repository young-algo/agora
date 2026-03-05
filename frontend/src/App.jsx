import { useEffect, useMemo, useRef, useState } from "react";
import {
    Activity,
    Bot,
    Brain,
    Loader2,
    Play,
    Plus,
    Save,
    Sparkles,
    Square,
    Trash2
} from "lucide-react";
import { MODEL_GROUPS, findModelMeta } from "./lib/models";
import {
    BUILTIN_PRESETS,
    cloneConfig,
    deleteCustomPreset,
    getPresetById,
    loadSavedPresets,
    saveCustomPreset
} from "./lib/presets";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8001";

const EMPTY_RUN_STATE = {
    status: "idle",
    rounds: [],
    currentRound: 0,
    leader: "",
    supportTally: {},
    finalResult: null,
    error: "",
    startedAt: null
};

function makeAgent(index) {
    return {
        name: `agent-${index}`,
        model: "openai/gpt-5.4",
        system_prompt: "You are a helpful expert.",
        temperature: 0.3,
        use_thinking: false,
        thinking_budget: 16000,
        reasoning_effort: "medium",
        use_web_search: false
    };
}

function createPayload(config) {
    return {
        question: config.question,
        agents: config.agents.map((agent) => ({
            ...agent,
            temperature: Number(agent.temperature),
            use_thinking: Boolean(agent.use_thinking),
            thinking_budget: Number(agent.thinking_budget || 16000),
            reasoning_effort: agent.reasoning_effort || "medium",
            use_web_search: Boolean(agent.use_web_search)
        })),
        max_rounds: Number(config.maxRounds),
        consensus_threshold: Number(config.consensusThreshold),
        stable_rounds: Number(config.stableRounds),
        synthesizer_model: config.synthesizerModel || null,
        synthesizer_temperature: Number(config.synthesizerTemperature)
    };
}

export default function App() {
    const [config, setConfig] = useState(() => cloneConfig(BUILTIN_PRESETS[0].config));
    const [selectedPresetId, setSelectedPresetId] = useState(BUILTIN_PRESETS[0].id);
    const [savedPresets, setSavedPresets] = useState(() => loadSavedPresets());
    const [newPresetName, setNewPresetName] = useState("");
    const [runState, setRunState] = useState(EMPTY_RUN_STATE);

    const abortRef = useRef(null);

    const currentPreset = getPresetById(selectedPresetId, savedPresets) ?? BUILTIN_PRESETS[0];
    const isRunning = runState.status === "connecting" || runState.status === "running";

    const duplicateNames = useMemo(() => {
        const names = config.agents.map((a) => a.name.trim()).filter(Boolean);
        return new Set(names).size !== names.length;
    }, [config.agents]);

    const canRun = useMemo(() => {
        return (
            config.question.trim().length > 0 &&
            config.agents.length >= 2 &&
            !duplicateNames &&
            config.agents.every(
                (a) =>
                    a.name.trim() &&
                    a.model.trim() &&
                    a.system_prompt.trim() &&
                    Number(a.temperature) >= 0 &&
                    Number(a.temperature) <= 1
            )
        );
    }, [config, duplicateNames]);

    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    function patchConfig(key, value) {
        setConfig((prev) => ({ ...prev, [key]: value }));
    }

    function patchAgent(index, key, value) {
        setConfig((prev) => ({
            ...prev,
            agents: prev.agents.map((agent, i) =>
                i === index ? { ...agent, [key]: value } : agent
            )
        }));
    }

    function addAgent() {
        setConfig((prev) => ({
            ...prev,
            agents: [...prev.agents, makeAgent(prev.agents.length + 1)]
        }));
    }

    function removeAgent(index) {
        setConfig((prev) => {
            if (prev.agents.length <= 2) return prev;
            return {
                ...prev,
                agents: prev.agents.filter((_, i) => i !== index)
            };
        });
    }

    function applyPreset(id) {
        const preset = getPresetById(id, savedPresets);
        if (!preset) return;
        setSelectedPresetId(id);
        setConfig(cloneConfig(preset.config));
        setRunState(EMPTY_RUN_STATE);
    }

    function handleSavePreset() {
        if (!newPresetName.trim()) return;
        const nextSaved = saveCustomPreset(newPresetName.trim(), config);
        setSavedPresets(nextSaved);
        setNewPresetName("");
    }

    function handleDeletePreset(id) {
        const nextSaved = deleteCustomPreset(id);
        setSavedPresets(nextSaved);

        if (selectedPresetId === id) {
            setSelectedPresetId(BUILTIN_PRESETS[0].id);
            setConfig(cloneConfig(BUILTIN_PRESETS[0].config));
        }
    }

    async function handleRun() {
        setRunState({
            ...EMPTY_RUN_STATE,
            status: "connecting",
            startedAt: new Date().toISOString()
        });

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            await streamDebate(
                `${API_BASE_URL}/debate/stream`,
                createPayload(config),
                controller.signal,
                ({ event, payload }) => {
                    setRunState((prev) => {
                        if (event === "start") {
                            return {
                                ...prev,
                                status: "running",
                                error: "",
                                startedAt: prev.startedAt || new Date().toISOString()
                            };
                        }

                        if (event === "round_started") {
                            return {
                                ...prev,
                                status: "running",
                                currentRound: payload.round_num || prev.currentRound
                            };
                        }

                        if (event === "round_completed") {
                            const rounds = [...prev.rounds.filter((r) => r.round_num !== payload.round_num), payload]
                                .sort((a, b) => a.round_num - b.round_num);

                            return {
                                ...prev,
                                status: "running",
                                rounds,
                                currentRound: payload.round_num,
                                leader: payload.leader,
                                supportTally: payload.support_tally || {}
                            };
                        }

                        if (event === "final") {
                            return {
                                ...prev,
                                status: "done",
                                finalResult: payload.result,
                                leader: payload.result?.leader || prev.leader,
                                supportTally: payload.result?.support_tally || prev.supportTally
                            };
                        }

                        if (event === "error") {
                            return {
                                ...prev,
                                status: "error",
                                error: payload.message || "Streaming error"
                            };
                        }

                        return prev;
                    });
                }
            );
        } catch (err) {
            if (err?.name === "AbortError") {
                setRunState((prev) => ({
                    ...prev,
                    status: "aborted",
                    error: ""
                }));
            } else {
                setRunState((prev) => ({
                    ...prev,
                    status: "error",
                    error: err?.message || "Request failed"
                }));
            }
        } finally {
            abortRef.current = null;
        }
    }

    function handleStop() {
        abortRef.current?.abort();
    }

    return (
        <div className="min-h-screen">
            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
                <header className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="space-y-3">
                        <div className="section-title">Agentic LLM Debate Workbench</div>
                        <h1 className="text-4xl font-semibold tracking-tight text-white">
                            Multi-agent debate UI
                        </h1>
                        <p className="max-w-3xl text-slate-300">
                            Mix models across OpenAI, Anthropic, and Gemini, stream each round
                            live, and save reusable presets for recurring workflows.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <span className="badge-soft">Streaming rounds</span>
                        <span className="badge-soft">Cross-model agents</span>
                        <span className="badge-soft">Saved presets</span>
                    </div>
                </header>

                <div className="grid gap-6 xl:grid-cols-[440px_minmax(0,1fr)]">
                    <div className="space-y-6">
                        <Panel
                            title="Presets"
                            subtitle="Load built-ins or save your current setup to local storage."
                        >
                            <div className="grid gap-3">
                                {BUILTIN_PRESETS.map((preset) => (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        onClick={() => applyPreset(preset.id)}
                                        className={`rounded-2xl border p-4 text-left transition ${selectedPresetId === preset.id
                                            ? "border-cyan-400/50 bg-cyan-400/10"
                                            : "border-white/10 bg-white/5 hover:bg-white/10"
                                            }`}
                                    >
                                        <div className="mb-2 flex items-center justify-between gap-3">
                                            <div className="font-medium text-white">{preset.name}</div>
                                            <span className="badge-soft">{preset.category}</span>
                                        </div>
                                        <p className="text-sm text-slate-300">{preset.description}</p>
                                    </button>
                                ))}
                            </div>

                            <div className="mt-5">
                                <label className="mb-2 block text-sm text-slate-300">Load preset</label>
                                <select
                                    className="input-surface"
                                    value={selectedPresetId}
                                    onChange={(e) => applyPreset(e.target.value)}
                                >
                                    <optgroup label="Built-in presets">
                                        {BUILTIN_PRESETS.map((preset) => (
                                            <option key={preset.id} value={preset.id}>
                                                {preset.name}
                                            </option>
                                        ))}
                                    </optgroup>
                                    {savedPresets.length > 0 && (
                                        <optgroup label="Saved presets">
                                            {savedPresets.map((preset) => (
                                                <option key={preset.id} value={preset.id}>
                                                    {preset.name}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                </select>
                            </div>

                            <div className="mt-5 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                                <div className="mb-3 text-sm font-medium text-white">Save current preset</div>
                                <div className="flex gap-3">
                                    <input
                                        className="input-surface"
                                        placeholder="e.g. strict security code review"
                                        value={newPresetName}
                                        onChange={(e) => setNewPresetName(e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        className="btn-secondary shrink-0"
                                        onClick={handleSavePreset}
                                    >
                                        <Save className="h-4 w-4" />
                                        Save
                                    </button>
                                </div>
                            </div>

                            {savedPresets.length > 0 && (
                                <div className="mt-5">
                                    <div className="mb-2 text-sm text-slate-300">Saved presets</div>
                                    <div className="space-y-2">
                                        {savedPresets.map((preset) => (
                                            <div
                                                key={preset.id}
                                                className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => applyPreset(preset.id)}
                                                    className="text-left"
                                                >
                                                    <div className="font-medium text-white">{preset.name}</div>
                                                    <div className="text-xs text-slate-400">
                                                        {preset.updatedAt
                                                            ? `Updated ${new Date(preset.updatedAt).toLocaleString()}`
                                                            : "Custom preset"}
                                                    </div>
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={() => handleDeletePreset(preset.id)}
                                                    className="rounded-xl border border-rose-400/20 bg-rose-400/10 p-2 text-rose-200 hover:bg-rose-400/20"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </Panel>

                        <Panel
                            title="Debate setup"
                            subtitle="Question, convergence settings, and final synthesizer."
                        >
                            <label className="mb-2 block text-sm text-slate-300">Question</label>
                            <textarea
                                className="input-surface min-h-[180px]"
                                value={config.question}
                                onChange={(e) => patchConfig("question", e.target.value)}
                            />

                            <div className="mt-5 grid gap-4 sm:grid-cols-2">
                                <Field
                                    label="Max rounds"
                                    value={config.maxRounds}
                                    onChange={(v) => patchConfig("maxRounds", Number(v))}
                                    type="number"
                                    min="1"
                                />
                                <Field
                                    label="Consensus threshold"
                                    value={config.consensusThreshold}
                                    onChange={(v) => patchConfig("consensusThreshold", Number(v))}
                                    type="number"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                />
                                <Field
                                    label="Stable rounds"
                                    value={config.stableRounds}
                                    onChange={(v) => patchConfig("stableRounds", Number(v))}
                                    type="number"
                                    min="1"
                                />
                                <Field
                                    label="Synthesizer temperature"
                                    value={config.synthesizerTemperature}
                                    onChange={(v) => patchConfig("synthesizerTemperature", Number(v))}
                                    type="number"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                />
                            </div>

                            <div className="mt-5">
                                <label className="mb-2 block text-sm text-slate-300">
                                    Synthesizer model
                                </label>
                                <ModelPicker
                                    value={config.synthesizerModel}
                                    onChange={(value) => patchConfig("synthesizerModel", value)}
                                />
                            </div>
                        </Panel>

                        <Panel
                            title="Agents"
                            subtitle="Each agent can run on a different model and persona."
                            action={
                                <button type="button" className="btn-secondary" onClick={addAgent}>
                                    <Plus className="h-4 w-4" />
                                    Add agent
                                </button>
                            }
                        >
                            {duplicateNames && (
                                <div className="mb-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                                    Agent names must be unique, because agents vote by name.
                                </div>
                            )}

                            <div className="space-y-4">
                                {config.agents.map((agent, index) => (
                                    <AgentEditor
                                        key={`${agent.name}-${index}`}
                                        agent={agent}
                                        index={index}
                                        canRemove={config.agents.length > 2}
                                        onChange={patchAgent}
                                        onRemove={removeAgent}
                                    />
                                ))}
                            </div>
                        </Panel>
                    </div>

                    <div className="space-y-6">
                        <Panel
                            title="Live monitor"
                            subtitle="Streamed round updates from the backend."
                            action={
                                <div className="flex flex-wrap gap-3">
                                    <button
                                        type="button"
                                        className="btn-primary"
                                        onClick={handleRun}
                                        disabled={!canRun || isRunning}
                                    >
                                        {isRunning ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Play className="h-4 w-4" />
                                        )}
                                        {isRunning ? "Running..." : "Run debate"}
                                    </button>

                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={handleStop}
                                        disabled={!isRunning}
                                    >
                                        <Square className="h-4 w-4" />
                                        Stop
                                    </button>
                                </div>
                            }
                        >
                            <div className="mb-5 flex flex-wrap items-center gap-2">
                                <StatusBadge status={runState.status} />
                                {currentPreset && <span className="badge-soft">{currentPreset.name}</span>}
                            </div>

                            <div className="grid gap-4 sm:grid-cols-3">
                                <Stat
                                    icon={<Activity className="h-4 w-4" />}
                                    label="Current round"
                                    value={runState.currentRound || "—"}
                                />
                                <Stat
                                    icon={<Brain className="h-4 w-4" />}
                                    label="Leader"
                                    value={runState.leader || "—"}
                                />
                                <Stat
                                    icon={<Bot className="h-4 w-4" />}
                                    label="Agents"
                                    value={config.agents.length}
                                />
                            </div>

                            <div className="mt-5">
                                <div className="mb-2 text-sm text-slate-300">Support tally</div>
                                <div className="flex flex-wrap gap-2">
                                    {Object.keys(runState.supportTally || {}).length === 0 ? (
                                        <span className="text-sm text-slate-500">No votes yet.</span>
                                    ) : (
                                        Object.entries(runState.supportTally).map(([name, votes]) => (
                                            <span key={name} className="badge-soft">
                                                {name}: {votes}
                                            </span>
                                        ))
                                    )}
                                </div>
                            </div>

                            {runState.error && (
                                <div className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                                    {runState.error}
                                </div>
                            )}
                        </Panel>

                        <Panel
                            title="Final answer"
                            subtitle="The converged result or strongest surviving answer."
                        >
                            {runState.finalResult ? (
                                <div className="space-y-4">
                                    <div className="flex flex-wrap gap-2">
                                        <span className="badge-soft">
                                            Converged: {runState.finalResult.converged ? "Yes" : "No"}
                                        </span>
                                        <span className="badge-soft">
                                            Rounds: {runState.finalResult.rounds_run}
                                        </span>
                                        <span className="badge-soft">
                                            Leader: {runState.finalResult.leader}
                                        </span>
                                    </div>

                                    <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-5">
                                        <pre className="whitespace-pre-wrap text-sm leading-7 text-slate-100">
                                            {runState.finalResult.final_answer}
                                        </pre>
                                    </div>
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8 text-center text-slate-400">
                                    <Sparkles className="mx-auto mb-3 h-6 w-6" />
                                    Start a debate to see the final answer here.
                                </div>
                            )}
                        </Panel>

                        <Panel
                            title="Round transcript"
                            subtitle="Live round-by-round debate as it streams in."
                        >
                            {runState.rounds.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8 text-center text-slate-400">
                                    No rounds yet.
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {runState.rounds.map((round) => (
                                        <RoundCard key={round.round_num} round={round} />
                                    ))}
                                </div>
                            )}
                        </Panel>
                    </div>
                </div>
            </div>
        </div>
    );
}

async function streamDebate(url, payload, signal, onEvent) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal
    });

    if (!response.ok) {
        throw new Error((await response.text()) || "Streaming request failed");
    }

    if (!response.body) {
        throw new Error("Streaming not supported by this browser");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
            const parsed = parseSseChunk(chunk);
            if (parsed) onEvent(parsed);
        }
    }

    if (buffer.trim()) {
        const parsed = parseSseChunk(buffer);
        if (parsed) onEvent(parsed);
    }
}

function parseSseChunk(chunk) {
    let event = "message";
    const dataLines = [];

    for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
        }
    }

    if (!dataLines.length) return null;

    try {
        return {
            event,
            payload: JSON.parse(dataLines.join("\n"))
        };
    } catch {
        return null;
    }
}

function Panel({ title, subtitle, action, children }) {
    return (
        <section className="glass-panel p-5 sm:p-6">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-white">{title}</h2>
                    {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

function Field({ label, value, onChange, ...rest }) {
    return (
        <div>
            <label className="mb-2 block text-sm text-slate-300">{label}</label>
            <input
                className="input-surface"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                {...rest}
            />
        </div>
    );
}

function Stat({ icon, label, value }) {
    return (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
            <div className="mb-2 flex items-center gap-2 text-slate-400">
                {icon}
                <span className="text-xs uppercase tracking-[0.18em]">{label}</span>
            </div>
            <div className="text-lg font-semibold text-white">{value}</div>
        </div>
    );
}

function StatusBadge({ status }) {
    const styles = {
        idle: "border-white/10 bg-white/5 text-slate-200",
        connecting: "border-amber-300/20 bg-amber-400/10 text-amber-100",
        running: "border-cyan-300/20 bg-cyan-400/10 text-cyan-100",
        done: "border-emerald-300/20 bg-emerald-400/10 text-emerald-100",
        error: "border-rose-300/20 bg-rose-400/10 text-rose-100",
        aborted: "border-white/10 bg-slate-800 text-slate-200"
    };

    return (
        <span className={`badge-soft ${styles[status] || styles.idle}`}>
            Status: {status}
        </span>
    );
}

function ModelPicker({ value, onChange }) {
    const meta = findModelMeta(value);

    return (
        <div className="space-y-2">
            <select
                className="input-surface"
                value={meta ? value : ""}
                onChange={(e) => {
                    if (e.target.value) onChange(e.target.value);
                }}
            >
                <option value="">Choose from curated models</option>
                {MODEL_GROUPS.map((group) => (
                    <optgroup key={group.provider} label={group.provider}>
                        {group.models.map((model) => (
                            <option key={model.value} value={model.value}>
                                {model.label}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>

            <input
                className="input-surface"
                placeholder="Or type a custom LiteLLM model alias"
                value={meta ? "" : value}
                onChange={(e) => onChange(e.target.value)}
            />

            <p className="text-xs text-slate-400">
                {meta
                    ? `${meta.provider} · ${meta.note}`
                    : "You can also paste any provider/model alias supported by your LiteLLM setup."}
            </p>
        </div>
    );
}

function AgentEditor({ agent, index, canRemove, onChange, onRemove }) {
    return (
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-cyan-300" />
                    <div className="font-medium text-white">{agent.name || `Agent ${index + 1}`}</div>
                </div>

                {canRemove && (
                    <button
                        type="button"
                        className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm text-rose-100 hover:bg-rose-400/20"
                        onClick={() => onRemove(index)}
                    >
                        Remove
                    </button>
                )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
                <Field
                    label="Agent name"
                    value={agent.name}
                    onChange={(v) => onChange(index, "name", v)}
                />
                <Field
                    label="Temperature"
                    value={agent.temperature}
                    onChange={(v) => onChange(index, "temperature", Number(v))}
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3">
                    <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-white/10 bg-white/5 text-cyan-500"
                        checked={agent.use_thinking || false}
                        onChange={(e) => onChange(index, "use_thinking", e.target.checked)}
                    />
                    <label className="text-sm text-slate-300">Use Extended Thinking</label>
                </div>
                <div className="flex items-center gap-3">
                    <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-white/10 bg-white/5 text-cyan-500"
                        checked={agent.use_web_search || false}
                        onChange={(e) => onChange(index, "use_web_search", e.target.checked)}
                    />
                    <label className="text-sm text-slate-300">Enable Web Search</label>
                </div>
            </div>

            {agent.use_thinking && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                    <Field
                        label="Thinking Budget (tokens)"
                        value={agent.thinking_budget || 16000}
                        onChange={(v) => onChange(index, "thinking_budget", Number(v))}
                        type="number"
                        min="1024"
                        step="1024"
                    />
                    <div>
                        <label className="mb-2 block text-sm text-slate-300">Reasoning Effort (low/medium/high)</label>
                        <select
                            className="input-surface"
                            value={agent.reasoning_effort || "medium"}
                            onChange={(e) => onChange(index, "reasoning_effort", e.target.value)}
                        >
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                        </select>
                    </div>
                </div>
            )}

            <div className="mt-4">
                <label className="mb-2 block text-sm text-slate-300">Model</label>
                <ModelPicker
                    value={agent.model}
                    onChange={(value) => onChange(index, "model", value)}
                />
            </div>

            <div className="mt-4">
                <label className="mb-2 block text-sm text-slate-300">System prompt</label>
                <textarea
                    className="input-surface min-h-[110px]"
                    value={agent.system_prompt}
                    onChange={(e) => onChange(index, "system_prompt", e.target.value)}
                />
            </div>
        </div>
    );
}

function RoundCard({ round }) {
    return (
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="badge-soft">Round {round.round_num}</span>
                <span className="badge-soft">Leader: {round.leader}</span>
                <span className="badge-soft">
                    Support: {Math.round((round.ratio || 0) * 100)}%
                </span>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
                {Object.entries(round.support_tally || {}).map(([name, votes]) => (
                    <span key={name} className="badge-soft">
                        {name}: {votes}
                    </span>
                ))}
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                {round.turns?.map((turn, idx) => (
                    <div
                        key={`${turn.agent}-${idx}`}
                        className="rounded-2xl border border-white/10 bg-slate-950/70 p-4"
                    >
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div className="font-medium text-white">{turn.agent}</div>
                            <span className="badge-soft">supports {turn.support_for}</span>
                        </div>

                        <div className="mb-3 text-xs text-slate-400">
                            confidence {Number(turn.confidence || 0).toFixed(2)} · changed mind:{" "}
                            {turn.changed_mind ? "yes" : "no"}
                        </div>

                        <SectionBlock title="Answer">
                            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
                                {turn.answer}
                            </p>
                        </SectionBlock>

                        <SectionBlock title="Reasoning">
                            {turn.reasoning?.length ? (
                                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                                    {turn.reasoning.map((item, i) => (
                                        <li key={i}>{item}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-slate-500">No reasoning provided.</p>
                            )}
                        </SectionBlock>

                        <SectionBlock title="Critiques">
                            {turn.critiques?.length ? (
                                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                                    {turn.critiques.map((item, i) => (
                                        <li key={i}>
                                            <span className="font-medium text-white">{item.target}:</span>{" "}
                                            {item.critique}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-slate-500">No critiques provided.</p>
                            )}
                        </SectionBlock>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SectionBlock({ title, children }) {
    return (
        <div className="mb-4 last:mb-0">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                {title}
            </div>
            {children}
        </div>
    );
}
