export const MODEL_GROUPS = [
    {
        provider: "OpenAI",
        models: [
            {
                value: "openai/gpt-5.4",
                label: "GPT-5.4",
                note: "Best all-around OpenAI choice"
            },
            {
                value: "openai/gpt-5-mini",
                label: "GPT-5 Mini",
                note: "Stable legacy option"
            }
        ]
    },
    {
        provider: "Anthropic",
        models: [
            {
                value: "anthropic/claude-opus-4-6",
                label: "Claude 4.6 Opus",
                note: "Excellent general reasoning and critique"
            },
            {
                value: "anthropic/claude-sonnet-4-6",
                label: "Claude 4.6 Sonnet",
                note: "Very strong deep analysis"
            },
            {
                value: "anthropic/claude-haiku-4-5-20251001",
                label: "Claude 4.5 Haiku",
                note: "Balanced performance/cost"
            }
        ]
    },
    {
        provider: "Gemini",
        models: [
            {
                value: "gemini/gemini-3.1-pro-preview",
                label: "Gemini 3.1 Pro",
                note: "Strong long-context and synthesis"
            },
            {
                value: "gemini/gemini-3-flash-preview",
                label: "Gemini 3 Flash",
                note: "Fast and cost-efficient"
            },
            {
                value: "gemini/gemini-3.1-flash-lite-preview",
                label: "Gemini 3.1 Flash Lite",
                note: "Minimal thinking, super fast"
            }
        ]
    }
];

export function findModelMeta(value) {
    for (const group of MODEL_GROUPS) {
        for (const model of group.models) {
            if (model.value === value) {
                return { ...model, provider: group.provider };
            }
        }
    }
    return null;
}
