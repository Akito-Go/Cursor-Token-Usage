export type UsageCategory = "model" | "automation" | "other";
export type ModelPool = "cursor" | "other";

/** Grok, Composer, and Auto draw from Cursor Models. Claude, GPT, and Gemini are Other Models. */
const CURSOR_POOL_RE = /(^|[^a-z0-9])(auto|composer|cursor-small|grok|vega|default)([^a-z0-9]|$)/;

export function modelPool(model: string): ModelPool {
  return CURSOR_POOL_RE.test(model.toLowerCase()) ? "cursor" : "other";
}

const AUTOMATION_RE = /(^|[^a-z0-9])(bot|automation|bugbot)([^a-z0-9]|$)|background-agent|cloud-agent/;

/** Group a usage model name. Grok BOT / automation stays out of normal model usage. */
export function usageCategory(model: string): UsageCategory {
  const name = model.toLowerCase();
  if (AUTOMATION_RE.test(name)) return "automation";
  if (!name.trim() || name === "unknown") return "other";
  return "model";
}
