const STORAGE_KEY = "debate-ui-custom-presets-v1";

export const BUILTIN_PRESETS = [
    {
        id: "code-review",
        name: "Code Review Council",
        category: "Engineering",
        description:
            "Three specialized reviewers debate correctness, security, and performance before converging on the best review summary.",
        config: {
            question:
                "Review this code change for correctness, maintainability, test coverage, performance, and security. Prioritize blocking issues first, then suggested improvements.\n\n<PASTE PR SUMMARY OR CODE HERE>",
            maxRounds: 4,
            consensusThreshold: 0.67,
            stableRounds: 2,
            synthesizerModel: "openai/gpt-5.4",
            synthesizerTemperature: 0.2,
            agents: [
                {
                    name: "staff-architect",
                    model: "openai/gpt-5.4",
                    system_prompt:
                        "You are a senior staff engineer focused on correctness, design quality, maintainability, and tests.",
                    temperature: 0.2
                },
                {
                    name: "security-reviewer",
                    model: "anthropic/claude-sonnet-4-6",
                    system_prompt:
                        "You are a security reviewer focused on auth, data leakage, injection, unsafe defaults, and abuse cases.",
                    temperature: 0.2
                },
                {
                    name: "performance-reviewer",
                    model: "gemini/gemini-3.1-pro-preview",
                    system_prompt:
                        "You are a performance and reliability reviewer focused on latency, scaling, concurrency, observability, and operational simplicity.",
                    temperature: 0.2
                }
            ]
        }
    },
    {
        id: "trading-strategy",
        name: "Trading Strategy Review",
        category: "Research",
        description:
            "A quant, risk manager, and execution engineer debate robustness, overfitting, and implementation feasibility. Informational only.",
        config: {
            question:
                "Evaluate this trading strategy for robustness, execution feasibility, market regime sensitivity, and risk controls. Flag overfitting, data leakage, survivorship bias, and weak assumptions. This is for research only, not investment advice.\n\n<PASTE STRATEGY HERE>",
            maxRounds: 5,
            consensusThreshold: 0.67,
            stableRounds: 2,
            synthesizerModel: "anthropic/claude-sonnet-4-6",
            synthesizerTemperature: 0.2,
            agents: [
                {
                    name: "quant-researcher",
                    model: "anthropic/claude-sonnet-4-6",
                    system_prompt:
                        "You are a quantitative researcher focused on signal validity, backtest quality, and regime dependence.",
                    temperature: 0.2
                },
                {
                    name: "risk-manager",
                    model: "openai/gpt-5.4",
                    system_prompt:
                        "You are a risk manager focused on drawdowns, correlation risk, tail events, position sizing, and failure modes.",
                    temperature: 0.2
                },
                {
                    name: "execution-engineer",
                    model: "gemini/gemini-3.1-pro-preview",
                    system_prompt:
                        "You are an execution engineer focused on slippage, liquidity, latency, implementation complexity, and monitoring.",
                    temperature: 0.2
                }
            ]
        }
    }
];

export function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config));
}

export function loadSavedPresets() {
    try {
        if (typeof window === "undefined") return [];
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function slugify(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
}

export function saveCustomPreset(name, config) {
    const id = `custom-${slugify(name)}`;
    const next = [
        {
            id,
            name,
            category: "Custom",
            description: "Saved from the current UI configuration",
            config: cloneConfig(config),
            updatedAt: new Date().toISOString()
        },
        ...loadSavedPresets().filter((p) => p.id !== id)
    ];

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
}

export function deleteCustomPreset(id) {
    const next = loadSavedPresets().filter((p) => p.id !== id);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
}

export function getPresetById(id, savedPresets = []) {
    return (
        BUILTIN_PRESETS.find((p) => p.id === id) ||
        savedPresets.find((p) => p.id === id) ||
        null
    );
}
