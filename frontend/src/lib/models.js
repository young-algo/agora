export const MODEL_GROUPS = [
    {
        provider: "OpenAI",
        models: [
            {
                value: "openai/gpt-4o",
                label: "GPT-4o",
                note: "Best all-around OpenAI choice"
            },
            {
                value: "openai/gpt-4-turbo",
                label: "GPT-4 Turbo",
                note: "Strong reasoning and long context"
            },
            {
                value: "openai/gpt-4",
                label: "GPT-4",
                note: "Stable legacy option"
            }
        ]
    },
    {
        provider: "Anthropic",
        models: [
            {
                value: "anthropic/claude-3-5-sonnet-20240620",
                label: "Claude 3.5 Sonnet",
                note: "Excellent general reasoning and critique"
            },
            {
                value: "anthropic/claude-3-opus-20240229",
                label: "Claude 3 Opus",
                note: "Very strong deep analysis"
            },
            {
                value: "anthropic/claude-3-sonnet-20240229",
                label: "Claude 3 Sonnet",
                note: "Balanced performance/cost"
            }
        ]
    },
    {
        provider: "Gemini",
        models: [
            {
                value: "gemini/gemini-1.5-pro",
                label: "Gemini 1.5 Pro",
                note: "Strong long-context and synthesis"
            },
            {
                value: "gemini/gemini-1.5-flash",
                label: "Gemini 1.5 Flash",
                note: "Fast and cost-efficient"
            },
            {
                value: "gemini/gemini-1.0-pro",
                label: "Gemini 1.0 Pro",
                note: "Stable fallback option"
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
