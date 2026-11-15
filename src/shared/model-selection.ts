import type { ModelInfo, ModelsPayload } from "./types.js";

const PRESET_MODELS = new Set(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);

export function isPresetModel(model: ModelInfo): boolean {
	return PRESET_MODELS.has(`${model.provider}/${model.id}`);
}

export function getSelectableModels(models: ModelsPayload | null): ModelInfo[] {
	if (!models) return [];
	const enabled = new Set(models.enabled);
	const candidates = [...models.available, ...models.all.filter((model) => model.provider === "deepseek" && !model.hasAuth)];
	return candidates.filter((model) => isPresetModel(model) || (
		enabled.size > 0 ? enabled.has(`${model.provider}/${model.id}`) : model.hasAuth
	));
}
