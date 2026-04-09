# Changelog

## [1.2.0] - 2026-04-09

### Changed
- Prompt injection now only fires at T-2 (expiry warning) and T-0 (auto-revert) — no more per-turn status noise
- Clarified that `model` and `provider` are always independent fields — no combined `provider/model` parsing

## [1.1.0] - 2026-04-09

### Added
- `provider` field in mode config — set provider independently of model (e.g. `"anthropic"`, `"openai"`)
- `providerOverride` support in `before_model_resolve` hook
- Sensible neutral defaults for `focused` mode (`anthropic/claude-opus-4.6`)

### Fixed
- Removed reason from console logs
- Removed `thinking` field from public interface (not yet supported by plugin API)
- Cleared private provider references from defaults

## [1.0.0] - 2026-04-09

### Added
- Initial release
- `switch_mode` tool with configurable modes
- `before_model_resolve` hook for model override
- `before_prompt_build` hook for mode status injection
- `after_compaction` hook to preserve state
- Auto-revert after configurable turn count
- `extend` pseudo-mode to reset countdown
- Default modes: `baseline` and `focused`
