// The adaptive routing core lives in provider-core so package-based providers (Qwen/acpRegistry,
// OpenCode, Cursor, ...) can reuse it without importing across the apps/server boundary.
export {
  adaptiveTaskIsUnclear,
  adaptiveUsageTokens,
  classifyAdaptiveTask,
  resolveAdaptiveTurn,
  usesAdaptiveSelection,
  type AdaptivePrecheck,
  type AdaptiveProviderCapabilities,
  type AdaptiveTurnHistory,
} from "@t3tools/provider-core/server/adaptiveRouting";
