export const AI_PROVIDER_DESCRIPTORS = [
  {
    id: "openai-responses",
    label: "OpenAI Responses API",
    defaultEndpoint: "https://api.openai.com/v1/responses",
    supportsApiKey: true,
    supportsReasoning: true
  },
  {
    id: "openai-chat-completions",
    label: "OpenAI Chat Completions API",
    defaultEndpoint: "https://api.openai.com/v1/chat/completions",
    supportsApiKey: true,
    supportsReasoning: true
  },
  {
    id: "openai-completions",
    label: "OpenAI Completions API",
    defaultEndpoint: "https://api.openai.com/v1/completions",
    supportsApiKey: true,
    supportsReasoning: false
  },
  {
    id: "glossa-backend",
    label: "Glossa 后端",
    defaultEndpoint: "http://127.0.0.1:8787",
    supportsApiKey: false,
    supportsReasoning: true
  }
] as const;

export type AiProviderDescriptor = typeof AI_PROVIDER_DESCRIPTORS[number];
export type AiProvider = AiProviderDescriptor["id"];
export const AI_PROVIDERS = AI_PROVIDER_DESCRIPTORS.map(provider => provider.id);
export const DEFAULT_AI_PROVIDER: AiProvider = "openai-responses";

export function getAiProviderDescriptor(provider: AiProvider): AiProviderDescriptor {
  const descriptor = AI_PROVIDER_DESCRIPTORS.find(value => value.id === provider);
  if (!descriptor) throw new Error(`Unknown AI provider: ${provider}`);
  return descriptor;
}
