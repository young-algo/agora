import { useEffect, useMemo, useRef, useState } from "react";
import {
    Activity,
    Bot,
    Brain,
    ChevronDown,
    ChevronRight,
    Loader2,
    Play,
    Plus,
    Download,
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
const DENSITY_STORAGE_KEY = "debate-ui-density-v1";
const APPEARANCE_STORAGE_KEY = "debate-ui-appearance-v1";
const ANALYSIS_PHASE_LABELS = ["Clarify", "Research", "Challenge"];

const EMPTY_RUN_STATE = {
    status: "idle",
    workflowMode: "",
    rounds: [],
    phases: [],
    phaseLabels: [],
    currentRound: 0,
    currentPhaseIndex: 0,
    currentPhaseLabel: "",
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

function buildResultMarkdown(result, question) {
    const lines = [];
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    lines.push(`# Agora — ${result.workflow_mode === "analysis" ? "Analysis" : "Debate"} Result`);
    lines.push(`> ${ts}\n`);

    if (question) lines.push(`## Question\n\n${question}\n`);

    if (result.workflow_mode === "analysis") {
        lines.push(`**Phases:** ${result.phases_run}  `);
        lines.push(`**Winning agent:** ${result.winning_agent || "—"}\n`);
        if (result.executive_summary) {
            lines.push(`## Executive Summary\n\n${result.executive_summary}\n`);
        }
        lines.push(`## Final Answer\n\n${result.final_answer}\n`);
        const sections = [
            ["Why This Answer", result.why_this_answer],
            ["Key Uncertainties", result.uncertainties],
            ["Credible Alternatives", result.alternatives],
            ["Follow-ups", result.follow_ups],
        ];
        for (const [title, items] of sections) {
            if (items?.length) {
                lines.push(`### ${title}\n`);
                items.forEach((item) => lines.push(`- ${item}`));
                lines.push("");
            }
        }
    } else {
        lines.push(`**Converged:** ${result.converged ? "Yes" : "No"}  `);
        lines.push(`**Rounds:** ${result.rounds_run}  `);
        lines.push(`**Leader:** ${result.leader}\n`);
        lines.push(`## Final Answer\n\n${result.final_answer}\n`);
    }

    if (result.transcript?.length) {
        lines.push(`## Transcript\n`);
        for (const round of result.transcript) {
            const turns = Array.isArray(round) ? round : round.turns || [];
            const heading = round.phase_label
                ? `### Phase: ${round.phase_label}`
                : `### Round ${turns[0]?.round_num ?? "?"}`;
            lines.push(heading + "\n");
            for (const t of turns) {
                lines.push(`#### ${t.agent} (confidence ${Number(t.confidence || 0).toFixed(2)})\n`);
                lines.push(`${t.answer}\n`);
                if (t.reasoning?.length) {
                    lines.push("**Reasoning:**\n");
                    t.reasoning.forEach((r) => lines.push(`- ${r}`));
                    lines.push("");
                }
                if (t.critiques?.length) {
                    lines.push("**Critiques:**\n");
                    t.critiques.forEach((c) => lines.push(`- **${c.target}:** ${c.critique}`));
                    lines.push("");
                }
            }
        }
    }

    return lines.join("\n");
}

function downloadMarkdown(text, filename) {
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function createPayload(config) {
    return {
        question: config.question,
        workflow_mode: config.workflowMode || "debate",
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

function loadDensityPreference() {
    try {
        if (typeof window === "undefined") return "comfortable";
        const saved = window.localStorage.getItem(DENSITY_STORAGE_KEY);
        return saved === "compact" || saved === "comfortable" ? saved : "comfortable";
    } catch {
        return "comfortable";
    }
}

function loadAppearancePreference() {
    try {
        if (typeof window === "undefined") return "dark";
        const saved = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
        return saved === "light" || saved === "dark" ? saved : "dark";
    } catch {
        return "dark";
    }
}

export default function App() {
    const [config, setConfig] = useState(() => cloneConfig(BUILTIN_PRESETS[0].config));
    const [selectedPresetId, setSelectedPresetId] = useState(BUILTIN_PRESETS[0].id);
    const [savedPresets, setSavedPresets] = useState(() => loadSavedPresets());
    const [newPresetName, setNewPresetName] = useState("");
    const [runState, setRunState] = useState(EMPTY_RUN_STATE);
    const [density, setDensity] = useState(loadDensityPreference);
    const [appearance, setAppearance] = useState(loadAppearancePreference);
    const [openSections, setOpenSections] = useState({
        presets: true,
        setup: true,
        agents: true
    });
    const [openAgentIndex, setOpenAgentIndex] = useState(0);

    const abortRef = useRef(null);

    const currentPreset = getPresetById(selectedPresetId, savedPresets) ?? BUILTIN_PRESETS[0];
    const isRunning = runState.status === "connecting" || runState.status === "running";
    const configuredWorkflowMode = config.workflowMode || "debate";
    const activeWorkflowMode = runState.workflowMode || configuredWorkflowMode;
    const isAnalysisMode = activeWorkflowMode === "analysis";
    const timelineLabels = isAnalysisMode
        ? (runState.phaseLabels.length ? runState.phaseLabels : ANALYSIS_PHASE_LABELS)
        : Array.from({ length: Math.max(1, Number(config.maxRounds) || 1) }, (_, index) => `${index + 1}`);
    const progressIndex = isAnalysisMode
        ? (runState.finalResult?.phases_run || runState.currentPhaseIndex || 0)
        : (runState.finalResult?.rounds_run || runState.currentRound || 0);
    const progressLabel = isAnalysisMode
        ? (runState.currentPhaseLabel || (progressIndex ? timelineLabels[progressIndex - 1] : ""))
        : "";

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

    useEffect(() => {
        try {
            window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
        } catch {
            // no-op
        }
    }, [density]);

    useEffect(() => {
        try {
            window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
        } catch {
            // no-op
        }
    }, [appearance]);

    useEffect(() => {
        document.body.classList.toggle("theme-light", appearance === "light");
        return () => {
            document.body.classList.remove("theme-light");
        };
    }, [appearance]);

    useEffect(() => {
        if (openAgentIndex > config.agents.length - 1) {
            setOpenAgentIndex(Math.max(0, config.agents.length - 1));
        }
    }, [config.agents.length, openAgentIndex]);

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
        setConfig((prev) => {
            const nextIndex = prev.agents.length;
            setOpenAgentIndex(nextIndex);
            return {
                ...prev,
                agents: [...prev.agents, makeAgent(prev.agents.length + 1)]
            };
        });
    }

    function removeAgent(index) {
        setConfig((prev) => {
            if (prev.agents.length <= 2) return prev;
            return {
                ...prev,
                agents: prev.agents.filter((_, i) => i !== index)
            };
        });

        setOpenAgentIndex((currentOpen) => {
            if (currentOpen === index) return Math.max(0, index - 1);
            if (currentOpen > index) return currentOpen - 1;
            return currentOpen;
        });
    }

    function applyPreset(id) {
        const preset = getPresetById(id, savedPresets);
        if (!preset) return;
        setSelectedPresetId(id);
        setConfig(cloneConfig(preset.config));
        setRunState(EMPTY_RUN_STATE);
        setOpenAgentIndex(0);
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
            setOpenAgentIndex(0);
        }
    }

    async function handleRun() {
        setRunState({
            ...EMPTY_RUN_STATE,
            workflowMode: config.workflowMode || "debate",
            phaseLabels: config.workflowMode === "analysis" ? ANALYSIS_PHASE_LABELS : [],
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
                                workflowMode: payload.workflow_mode || prev.workflowMode,
                                phaseLabels: payload.phase_labels || prev.phaseLabels,
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

                        if (event === "phase_started") {
                            return {
                                ...prev,
                                status: "running",
                                currentPhaseIndex: payload.phase_index || prev.currentPhaseIndex,
                                currentPhaseLabel: payload.phase_label || prev.currentPhaseLabel,
                                phaseLabels: prev.phaseLabels.length
                                    ? prev.phaseLabels
                                    : ANALYSIS_PHASE_LABELS
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

                        if (event === "phase_completed") {
                            const phases = [...prev.phases.filter((p) => p.phase_index !== payload.phase_index), payload]
                                .sort((a, b) => a.phase_index - b.phase_index);

                            return {
                                ...prev,
                                status: "running",
                                phases,
                                currentPhaseIndex: payload.phase_index || prev.currentPhaseIndex,
                                currentPhaseLabel: payload.phase_label || prev.currentPhaseLabel
                            };
                        }

                        if (event === "final") {
                            return {
                                ...prev,
                                status: "done",
                                finalResult: payload.result,
                                workflowMode: payload.result?.workflow_mode || prev.workflowMode,
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

    function toggleSection(sectionKey) {
        setOpenSections((prev) => ({
            ...prev,
            [sectionKey]: !prev[sectionKey]
        }));
    }

    return (
        <div
            className={`app-shell theme-${appearance} ${density === "compact" ? "density-compact" : "density-comfortable"}`}
        >
            <MobileActionBar
                canRun={canRun}
                currentPreset={currentPreset}
                isRunning={isRunning}
                onRun={handleRun}
                onStop={handleStop}
                status={runState.status}
                workflowMode={activeWorkflowMode}
                progressIndex={progressIndex}
                progressLabel={progressLabel}
                progressTotal={timelineLabels.length}
            />

            <div className="mx-auto max-w-[1500px] px-4 pb-28 pt-6 sm:px-6 lg:px-8 lg:pb-10">
                <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="space-y-3">
                        <h1 className="logo-text">Agora</h1>
                        <div className="section-title">Agentic LLM Reasoning Workbench</div>
                        <p className="max-w-3xl text-slate-300">
                            Mix models across providers, run either debates or structured analysis workflows,
                            and save reusable presets for recurring questions.
                        </p>
                    </div>

                    <div className="flex items-center gap-2 whitespace-nowrap">
                        <AppearanceToggle appearance={appearance} onChange={setAppearance} />
                        <DensityToggle density={density} onChange={setDensity} />
                    </div>
                </header>

                <div className="grid gap-6 xl:grid-cols-[440px_minmax(0,1fr)]">
                    <div className="order-2 space-y-6 xl:order-1">
                        <CollapsiblePanel
                            title="Presets"
                            subtitle="Load built-ins or save your current setup to local storage."
                            isOpen={openSections.presets}
                            onToggle={() => toggleSection("presets")}
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
                        </CollapsiblePanel>

                        <CollapsiblePanel
                            title={configuredWorkflowMode === "analysis" ? "Workflow setup" : "Debate setup"}
                            subtitle={
                                configuredWorkflowMode === "analysis"
                                    ? "Pick the workflow, write the brief, and choose the final synthesizer."
                                    : "Question, convergence settings, and final synthesizer."
                            }
                            isOpen={openSections.setup}
                            onToggle={() => toggleSection("setup")}
                        >
                            <div className="mb-5">
                                <div className="mb-2 block text-sm text-slate-300">Workflow</div>
                                <WorkflowToggle
                                    value={config.workflowMode}
                                    onChange={(value) => {
                                        patchConfig("workflowMode", value);
                                        setRunState({
                                            ...EMPTY_RUN_STATE,
                                            workflowMode: value,
                                            phaseLabels: value === "analysis" ? ANALYSIS_PHASE_LABELS : []
                                        });
                                    }}
                                />
                            </div>

                            <label className="mb-2 block text-sm text-slate-300">
                                {configuredWorkflowMode === "analysis" ? "Question or brief" : "Question"}
                            </label>
                            <textarea
                                className="input-surface min-h-[180px]"
                                value={config.question}
                                onChange={(e) => patchConfig("question", e.target.value)}
                            />

                            {configuredWorkflowMode === "analysis" ? (
                                <div className="mt-5 rounded-2xl border border-cyan-400/20 bg-cyan-400/6 p-4">
                                    <div className="mb-3 text-sm font-medium text-cyan-100">
                                        Structured analysis pipeline
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {ANALYSIS_PHASE_LABELS.map((label) => (
                                            <span key={label} className="badge-soft">
                                                {label}
                                            </span>
                                        ))}
                                    </div>
                                    <p className="mt-3 text-sm text-slate-300">
                                        Analysis mode keeps the workflow fixed so the UI stays compact while
                                        still producing a stronger, more explicit final synthesis.
                                    </p>
                                </div>
                            ) : (
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
                            )}

                            {configuredWorkflowMode === "analysis" ? (
                                <div className="mt-5">
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
                            ) : null}

                            <div className="mt-5">
                                <label className="mb-2 block text-sm text-slate-300">
                                    {configuredWorkflowMode === "analysis"
                                        ? "Final synthesizer model"
                                        : "Synthesizer model"}
                                </label>
                                <ModelPicker
                                    value={config.synthesizerModel}
                                    onChange={(value) => patchConfig("synthesizerModel", value)}
                                />
                            </div>
                        </CollapsiblePanel>

                        <CollapsiblePanel
                            title="Agents"
                            subtitle={
                                configuredWorkflowMode === "analysis"
                                    ? "Each agent acts as a reusable role inside the structured analysis pipeline."
                                    : "Each agent can run on a different model and persona."
                            }
                            isOpen={openSections.agents}
                            onToggle={() => toggleSection("agents")}
                            action={
                                <button type="button" className="btn-secondary" onClick={addAgent}>
                                    <Plus className="h-4 w-4" />
                                    Add agent
                                </button>
                            }
                        >
                            {duplicateNames && (
                                <div className="mb-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                                    Agent names must be unique so critiques, summaries, and votes can reference
                                    them clearly.
                                </div>
                            )}

                            <div className="space-y-4">
                                {config.agents.map((agent, index) => (
                                    <AgentEditor
                                        key={`${agent.name}-${index}`}
                                        agent={agent}
                                        index={index}
                                        isOpen={openAgentIndex === index}
                                        canRemove={config.agents.length > 2}
                                        onToggle={() => setOpenAgentIndex(index)}
                                        onChange={patchAgent}
                                        onRemove={removeAgent}
                                    />
                                ))}
                            </div>
                        </CollapsiblePanel>
                    </div>

                    <div className="order-1 space-y-6 xl:order-2">
                        <div className="hidden xl:sticky xl:top-4 xl:z-30 xl:block">
                            <ActionStrip
                                canRun={canRun}
                                currentPreset={currentPreset}
                                isRunning={isRunning}
                                onRun={handleRun}
                                onStop={handleStop}
                                status={runState.status}
                                workflowMode={activeWorkflowMode}
                                progressIndex={progressIndex}
                                progressLabel={progressLabel}
                                progressTotal={timelineLabels.length}
                            />
                        </div>

                        <Panel
                            title="Live monitor"
                            subtitle={
                                isAnalysisMode
                                    ? "Streamed workflow phases from the backend."
                                    : "Streamed round updates from the backend."
                            }
                        >
                            <div className="mb-5 flex flex-wrap items-center gap-2">
                                <StatusBadge status={runState.status} />
                                {currentPreset && <span className="badge-soft">{currentPreset.name}</span>}
                                <span className="badge-soft">
                                    {isAnalysisMode ? "Analysis workflow" : "Debate workflow"}
                                </span>
                            </div>

                            <div className="mb-5">
                                <div className="mb-2 text-sm text-slate-300">
                                    {isAnalysisMode ? "Workflow timeline" : "Round timeline"}
                                </div>
                                <WorkflowTimeline
                                    labels={timelineLabels}
                                    activeIndex={progressIndex}
                                    status={runState.status}
                                />
                            </div>

                            {isAnalysisMode ? (
                                <>
                                    <div className="grid gap-4 sm:grid-cols-3">
                                        <Stat
                                            icon={<Activity className="h-4 w-4" />}
                                            label="Current phase"
                                            value={runState.currentPhaseLabel || "--"}
                                        />
                                        <Stat
                                            icon={<Brain className="h-4 w-4" />}
                                            label="Completed phases"
                                            value={runState.phases.length}
                                        />
                                        <Stat
                                            icon={<Bot className="h-4 w-4" />}
                                            label="Agents"
                                            value={config.agents.length}
                                        />
                                    </div>

                                    <div className="mt-5">
                                        <div className="mb-2 text-sm text-slate-300">Phase status</div>
                                        <div className="flex flex-wrap gap-2">
                                            {timelineLabels.map((label, index) => {
                                                const isDone = index + 1 <= progressIndex;
                                                return (
                                                    <span key={label} className={`badge-soft ${isDone ? "text-white" : ""}`}>
                                                        {label}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="grid gap-4 sm:grid-cols-3">
                                        <Stat
                                            icon={<Activity className="h-4 w-4" />}
                                            label="Current round"
                                            value={runState.currentRound || "--"}
                                        />
                                        <Stat
                                            icon={<Brain className="h-4 w-4" />}
                                            label="Leader"
                                            value={runState.leader || "--"}
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
                                </>
                            )}

                            {runState.error && (
                                <div className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                                    {runState.error}
                                </div>
                            )}
                        </Panel>

                        <Panel
                            title="Final answer"
                            subtitle={
                                isAnalysisMode
                                    ? "A final synthesis built from the strongest surviving analysis."
                                    : "The converged result or strongest surviving answer."
                            }
                        >
                            {runState.finalResult ? (
                                <div className="space-y-4">
                                    <div className="flex justify-end">
                                        <button
                                            className="btn-secondary flex items-center gap-1.5 text-xs"
                                            onClick={() => {
                                                const md = buildResultMarkdown(runState.finalResult, config.question);
                                                const slug = config.question.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/-$/, "");
                                                downloadMarkdown(md, `agora-${slug}.md`);
                                            }}
                                        >
                                            <Download className="h-3.5 w-3.5" />
                                            Save as Markdown
                                        </button>
                                    </div>
                                    {isAnalysisMode ? (
                                        <AnalysisFinalAnswer result={runState.finalResult} />
                                    ) : (
                                        <>
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

                                            <div className="result-surface">
                                                <pre className="whitespace-pre-wrap text-sm leading-7">
                                                    {runState.finalResult.final_answer}
                                                </pre>
                                            </div>
                                        </>
                                    )}
                                </div>
                            ) : (
                                <EmptyState
                                    icon={<Sparkles className="h-5 w-5" />}
                                    title={isRunning ? "Workflow in progress" : "No final answer yet"}
                                    text={
                                        isRunning
                                            ? isAnalysisMode
                                                ? "A synthesis appears after the final challenge phase."
                                                : "A synthesis appears after convergence or max rounds."
                                            : `Run a ${configuredWorkflowMode} workflow to see the final answer here.`
                                    }
                                />
                            )}
                        </Panel>

                        <Panel
                            title={isAnalysisMode ? "Workflow log" : "Round transcript"}
                            subtitle={
                                isAnalysisMode
                                    ? "Live phase-by-phase analysis as it streams in."
                                    : "Live round-by-round debate as it streams in."
                            }
                        >
                            {(isAnalysisMode ? runState.phases.length === 0 : runState.rounds.length === 0) ? (
                                <EmptyState
                                    title={
                                        isRunning
                                            ? isAnalysisMode
                                                ? "Waiting for phase output"
                                                : "Waiting for round output"
                                            : isAnalysisMode
                                                ? "No phases yet"
                                                : "No rounds yet"
                                    }
                                    text={
                                        isRunning
                                            ? isAnalysisMode
                                                ? "Phase events will stream here as each phase completes."
                                                : "Round events will stream here as each round completes."
                                            : `Run a ${configuredWorkflowMode} workflow to populate the log.`
                                    }
                                />
                            ) : (
                                <div className="space-y-4">
                                    {isAnalysisMode
                                        ? runState.phases.map((phase) => (
                                            <PhaseCard key={phase.phase_index} phase={phase} />
                                        ))
                                        : runState.rounds.map((round) => (
                                            <DebateRoundCard key={round.round_num} round={round} />
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

function DensityToggle({ density, onChange }) {
    return (
        <SegmentedToggle
            value={density}
            onChange={onChange}
            options={[
                { label: "Comfortable", value: "comfortable" },
                { label: "Compact", value: "compact" }
            ]}
        />
    );
}

function AppearanceToggle({ appearance, onChange }) {
    return (
        <SegmentedToggle
            value={appearance}
            onChange={onChange}
            options={[
                { label: "Default", value: "dark" },
                { label: "Light", value: "light" }
            ]}
        />
    );
}

function WorkflowToggle({ value, onChange }) {
    return (
        <SegmentedToggle
            value={value}
            onChange={onChange}
            options={[
                { label: "Debate", value: "debate" },
                { label: "Analysis", value: "analysis" }
            ]}
        />
    );
}

function SegmentedToggle({ value, onChange, options }) {
    return (
        <div className="toggle-group">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    className={`toggle-chip ${value === option.value ? "is-active" : ""}`}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}

function ActionStrip({
    canRun,
    currentPreset,
    isRunning,
    onRun,
    onStop,
    status,
    workflowMode,
    progressIndex,
    progressLabel,
    progressTotal
}) {
    return (
        <div className="action-strip">
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusBadge status={status} />
                {currentPreset && <span className="badge-soft">{currentPreset.name}</span>}
                <span className="badge-soft">
                    {workflowMode === "analysis"
                        ? `Phase ${progressIndex || 0}/${Math.max(1, Number(progressTotal) || 1)}`
                        : `Round ${progressIndex || 0}/${Math.max(1, Number(progressTotal) || 1)}`}
                </span>
                {progressLabel ? <span className="badge-soft">{progressLabel}</span> : null}
            </div>

            <div className="flex gap-2">
                <button
                    type="button"
                    className="btn-primary"
                    onClick={onRun}
                    disabled={!canRun || isRunning}
                >
                    {isRunning ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Play className="h-4 w-4" />
                    )}
                    {isRunning ? "Running..." : workflowMode === "analysis" ? "Run analysis" : "Run debate"}
                </button>

                <button type="button" className="btn-secondary" onClick={onStop} disabled={!isRunning}>
                    <Square className="h-4 w-4" />
                    Stop
                </button>
            </div>
        </div>
    );
}

function MobileActionBar({
    canRun,
    currentPreset,
    isRunning,
    onRun,
    onStop,
    status,
    workflowMode,
    progressIndex,
    progressLabel,
    progressTotal
}) {
    return (
        <div className="mobile-action-bar xl:hidden">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                        <StatusBadge status={status} />
                    </div>
                    <div className="truncate text-xs text-slate-400">
                        {currentPreset ? currentPreset.name : "No preset"}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                        {workflowMode === "analysis"
                            ? `Phase ${progressIndex || 0}/${Math.max(1, Number(progressTotal) || 1)}${progressLabel ? ` - ${progressLabel}` : ""}`
                            : `Round ${progressIndex || 0}/${Math.max(1, Number(progressTotal) || 1)}`}
                    </div>
                </div>

                <div className="flex shrink-0 gap-2">
                    <button
                        type="button"
                        className="btn-primary"
                        onClick={onRun}
                        disabled={!canRun || isRunning}
                    >
                        {isRunning ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Play className="h-4 w-4" />
                        )}
                        {workflowMode === "analysis" ? "Analyze" : "Run"}
                    </button>

                    <button
                        type="button"
                        className="btn-secondary"
                        onClick={onStop}
                        disabled={!isRunning}
                    >
                        <Square className="h-4 w-4" />
                        Stop
                    </button>
                </div>
            </div>
        </div>
    );
}

function CollapsiblePanel({ title, subtitle, isOpen, onToggle, action, children }) {
    return (
        <section className="glass-panel p-5 sm:p-6">
            <div className="mb-5 flex items-start gap-3">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    onClick={onToggle}
                >
                    {isOpen ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 text-slate-300" />
                    ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 text-slate-300" />
                    )}
                    <span className="min-w-0">
                        <span className="block text-xl font-semibold text-white">{title}</span>
                        {subtitle && <span className="mt-1 block text-sm text-slate-400">{subtitle}</span>}
                    </span>
                </button>
                {action}
            </div>

            {isOpen ? children : null}
        </section>
    );
}

function WorkflowTimeline({ labels, activeIndex, status }) {
    const safeLabels = labels.length ? labels : ["1"];
    const activeStep = Math.max(0, Number(activeIndex) || 0);

    return (
        <div className="timeline-track" aria-label="Workflow progress timeline">
            {safeLabels.map((label, index) => {
                const step = index + 1;
                const isComplete = step <= activeStep;
                const isActive = step === activeStep && status === "running";
                return (
                    <span
                        key={`${label}-${step}`}
                        className={`timeline-node ${isComplete ? "is-complete" : ""} ${isActive ? "is-active" : ""}`}
                        title={label}
                    >
                        {step}
                    </span>
                );
            })}
        </div>
    );
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
        <div className="panel-muted">
            <div className="mb-2 flex items-center gap-2 text-slate-400">
                {icon}
                <span className="text-xs font-semibold tracking-wide">{label}</span>
            </div>
            <div className="text-lg font-semibold text-white">{value}</div>
        </div>
    );
}

function StatusBadge({ status }) {
    const label = `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
    return <span className={`badge-soft status-badge status-${status}`}>{label}</span>;
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
                    ? `${meta.provider} - ${meta.note}`
                    : "You can also paste any provider/model alias supported by your LiteLLM setup."}
            </p>
        </div>
    );
}

function AgentEditor({ agent, index, isOpen, canRemove, onToggle, onChange, onRemove }) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const meta = findModelMeta(agent.model);
    const supportsThinking = meta?.supportsThinking !== false;
    const thinkingId = `agent-thinking-${index}`;
    const searchId = `agent-search-${index}`;

    useEffect(() => {
        if (!supportsThinking && agent.use_thinking) {
            onChange(index, "use_thinking", false);
            setAdvancedOpen(false);
            return;
        }

        if (!agent.use_thinking) {
            setAdvancedOpen(false);
        }
    }, [agent.use_thinking, index, onChange, supportsThinking]);

    return (
        <div className="agent-card">
            <div className="mb-3 flex items-start gap-2">
                <button
                    type="button"
                    className="agent-summary"
                    onClick={onToggle}
                    aria-expanded={isOpen}
                >
                    <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-cyan-200" />
                        <div className="font-medium text-white">{agent.name || `Agent ${index + 1}`}</div>
                        {isOpen ? (
                            <ChevronDown className="h-4 w-4 text-slate-400" />
                        ) : (
                            <ChevronRight className="h-4 w-4 text-slate-400" />
                        )}
                    </div>

                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-slate-300">
                        <span className="badge-soft">Temp {Number(agent.temperature).toFixed(2)}</span>
                        <span className="badge-soft">{meta?.label || agent.model}</span>
                        {agent.use_thinking ? <span className="badge-soft">Thinking</span> : null}
                        {agent.use_web_search ? <span className="badge-soft">Web</span> : null}
                    </div>
                </button>

                {canRemove && (
                    <button
                        type="button"
                        className="btn-danger"
                        onClick={() => onRemove(index)}
                    >
                        Remove
                    </button>
                )}
            </div>

            {isOpen ? (
                <div className="space-y-4">
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

                    <div className="grid gap-3 sm:grid-cols-2">
                        <label
                            htmlFor={thinkingId}
                            className="panel-muted flex cursor-pointer items-center gap-3"
                        >
                            <input
                                id={thinkingId}
                                type="checkbox"
                                className="h-4 w-4 rounded border-white/10 bg-white/5 text-cyan-500"
                                checked={supportsThinking && (agent.use_thinking || false)}
                                disabled={!supportsThinking}
                                onChange={(e) => onChange(index, "use_thinking", e.target.checked)}
                            />
                            <span className="text-sm text-slate-300">
                                {supportsThinking
                                    ? "Use extended thinking"
                                    : "Extended thinking unavailable for this model"}
                            </span>
                        </label>
                        <label
                            htmlFor={searchId}
                            className="panel-muted flex cursor-pointer items-center gap-3"
                        >
                            <input
                                id={searchId}
                                type="checkbox"
                                className="h-4 w-4 rounded border-white/10 bg-white/5 text-cyan-500"
                                checked={agent.use_web_search || false}
                                onChange={(e) => onChange(index, "use_web_search", e.target.checked)}
                            />
                            <span className="text-sm text-slate-300">Enable web search</span>
                        </label>
                    </div>

                    {agent.use_thinking && (
                        <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/6 p-3">
                            <button
                                type="button"
                                className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-cyan-100"
                                onClick={() => setAdvancedOpen((prev) => !prev)}
                            >
                                {advancedOpen ? (
                                    <ChevronDown className="h-4 w-4" />
                                ) : (
                                    <ChevronRight className="h-4 w-4" />
                                )}
                                Advanced reasoning settings
                            </button>

                            {advancedOpen ? (
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Field
                                        label="Thinking budget (tokens)"
                                        value={agent.thinking_budget || 16000}
                                        onChange={(v) => onChange(index, "thinking_budget", Number(v))}
                                        type="number"
                                        min="1024"
                                        step="1024"
                                    />
                                    <div>
                                        <label className="mb-2 block text-sm text-slate-300">
                                            Reasoning effort
                                        </label>
                                        <select
                                            className="input-surface"
                                            value={agent.reasoning_effort || "medium"}
                                            onChange={(e) =>
                                                onChange(index, "reasoning_effort", e.target.value)
                                            }
                                        >
                                            <option value="low">Low</option>
                                            <option value="medium">Medium</option>
                                            <option value="high">High</option>
                                        </select>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-slate-400">
                                    Advanced reasoning controls are hidden by default.
                                </p>
                            )}
                        </div>
                    )}

                    <div>
                        <label className="mb-2 block text-sm text-slate-300">Model</label>
                        <ModelPicker
                            value={agent.model}
                            onChange={(value) => onChange(index, "model", value)}
                        />
                        {!supportsThinking ? (
                            <p className="mt-2 text-xs text-amber-200">
                                This Anthropic model supports standard mode only.
                            </p>
                        ) : null}
                    </div>

                    <div>
                        <label className="mb-2 block text-sm text-slate-300">System prompt</label>
                        <textarea
                            className="input-surface min-h-[110px]"
                            value={agent.system_prompt}
                            onChange={(e) => onChange(index, "system_prompt", e.target.value)}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function AnalysisFinalAnswer({ result }) {
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                <span className="badge-soft">Phases: {result.phases_run}</span>
                <span className="badge-soft">Winning agent: {result.winning_agent || "--"}</span>
            </div>

            {result.executive_summary ? (
                <div className="result-callout">
                    <p className="whitespace-pre-wrap text-sm leading-7">{result.executive_summary}</p>
                </div>
            ) : null}

            <div className="result-surface">
                <pre className="whitespace-pre-wrap text-sm leading-7">{result.final_answer}</pre>
            </div>

            <ListBlock title="Why this answer" items={result.why_this_answer} emptyText="" />
            <ListBlock title="Key uncertainties" items={result.uncertainties} emptyText="" />
            <ListBlock title="Credible alternatives" items={result.alternatives} emptyText="" />
            <ListBlock title="Follow-ups" items={result.follow_ups} emptyText="" />
        </div>
    );
}

function PhaseCard({ phase }) {
    return (
        <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="badge-soft">{phase.phase_label}</span>
                {phase.phase_description ? (
                    <span className="text-sm text-slate-400">{phase.phase_description}</span>
                ) : null}
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                {phase.turns?.map((turn, idx) => (
                    <div
                        key={`${turn.agent}-${idx}`}
                        className="rounded-2xl border border-white/10 bg-slate-950/70 p-4"
                    >
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div className="font-medium text-white">{turn.agent}</div>
                            <span className="badge-soft">
                                confidence {Number(turn.confidence || 0).toFixed(2)}
                            </span>
                        </div>

                        <SectionBlock title="Answer">
                            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
                                {turn.answer}
                            </p>
                        </SectionBlock>

                        <ListBlock title="Claims" items={turn.claims} />
                        <ListBlock title="Evidence" items={turn.evidence} />
                        <ListBlock title="Assumptions" items={turn.assumptions} />
                        <ListBlock title="Uncertainties" items={turn.uncertainties} />

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
                                <p className="text-sm text-slate-500">No critiques recorded.</p>
                            )}
                        </SectionBlock>
                    </div>
                ))}
            </div>
        </div>
    );
}

function DebateRoundCard({ round }) {
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
                            confidence {Number(turn.confidence || 0).toFixed(2)} - changed mind:{" "}
                            {turn.changed_mind ? "yes" : "no"}
                        </div>

                        <SectionBlock title="Answer">
                            <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
                                {turn.answer}
                            </p>
                        </SectionBlock>

                        <ListBlock title="Reasoning" items={turn.reasoning} emptyText="No reasoning provided." />

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

function EmptyState({ icon, title, text }) {
    return (
        <div className="empty-state">
            {icon ? <div className="mb-2 text-slate-300">{icon}</div> : null}
            <div className="mb-1 text-sm font-medium text-slate-200">{title}</div>
            <p className="text-sm text-slate-400">{text}</p>
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

function ListBlock({ title, items, emptyText = "No items provided." }) {
    if (!items?.length && !emptyText) return null;

    return (
        <SectionBlock title={title}>
            {items?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
                    {items.map((item, index) => (
                        <li key={index}>{item}</li>
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-slate-500">{emptyText}</p>
            )}
        </SectionBlock>
    );
}
