# Changelog

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
