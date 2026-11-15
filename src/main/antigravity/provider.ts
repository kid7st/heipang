import { createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { RELAY_AUTH_SOURCE, resolveRelayApiKey } from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { hasRelayConfiguration } from "./client/relay.js";
import {
  ANTIGRAVITY_IMAGE_API,
  ANTIGRAVITY_IMAGE_MODELS,
  generateAntigravityImages,
} from "./image/native.js";
import {
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
} from "./models/index.js";
import { ANTIGRAVITY_API, type streamAntigravity } from "./stream/index.js";

export function antigravityProvider(stream: typeof streamAntigravity) {
  const modelIdentity = { provider: PROVIDER_ID, baseUrl: DEFAULT_ENDPOINT };
  const imageModels = ANTIGRAVITY_IMAGE_MODELS.map((model) => ({ ...model, ...modelIdentity }));
  const chatModels = (): Model<Api>[] =>
    getCurrentAntigravityCatalog().models.map((model) => ({
      ...model,
      ...modelIdentity,
      api: ANTIGRAVITY_API,
    }));
  const provider = createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    auth: {
      apiKey: {
        name: RELAY_AUTH_SOURCE,
        check: async () => hasRelayConfiguration() ? { type: "api_key", source: RELAY_AUTH_SOURCE } : undefined,
        resolve: async ({ signal }) => ({
          auth: { apiKey: await resolveRelayApiKey(signal) },
          source: RELAY_AUTH_SOURCE,
        }),
      },
    },
    models: [...chatModels(), ...imageModels],
    api: { stream, streamSimple: stream },
    images: { [ANTIGRAVITY_IMAGE_API]: { generateImages: generateAntigravityImages } },
  });
  return {
    ...provider,
    getModels: chatModels,
    getAllModels: () => [...chatModels(), ...imageModels],
    async refreshModels(context: Parameters<typeof refreshAntigravityModels>[0]) {
      const credential =
        context.allowNetwork && !context.signal.aborted
          ? { type: "api_key" as const, key: await resolveRelayApiKey(context.signal) }
          : undefined;
      await refreshAntigravityModels({ ...context, credential });
    },
  };
}
