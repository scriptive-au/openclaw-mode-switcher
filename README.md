# openclaw-mode-switcher

A plugin for [OpenClaw](https://openclaw.dev) that gives agents a `switch_mode` tool to self-escalate to a more capable model when a task demands it. The agent calls `switch_mode(mode: "focused", reason: "...")`, the plugin overrides the model for the next turn, injects a countdown reminder, and auto-reverts to baseline after N turns.

## Install

```
openclaw plugins install clawhub:openclaw-mode-switcher
```

## How it works

### The `switch_mode` tool

The agent is given a `switch_mode` tool at runtime. It accepts two required parameters:

- **`mode`** — the mode name to switch to (e.g. `"focused"`), or `"extend"` to reset the countdown without changing mode
- **`reason`** — a specific explanation of why more capability is needed (logged for cost tracking)

### Modes

Each mode is a named configuration that can override the model, thinking budget, and turn limit. Modes are merged at registration time — if a mode sets `model: null`, the session default is used unchanged.

### Turn countdown and auto-revert

When a mode has a `maxTurns` limit, the plugin counts down each turn via the `before_prompt_build` hook, injecting a hidden system reminder with the remaining count. At `T-1` the agent is nudged to extend or de-escalate. When the countdown reaches zero, the mode auto-reverts to `baseline` on the next turn.

The `extend` pseudo-mode resets the countdown to `maxTurns` without changing the active mode.

### State across compaction

Mode state (current mode, turns remaining, reason) is preserved across context compaction via the `after_compaction` hook — the agent picks up exactly where it left off.

## Default modes

| Mode | Description | Model | Max turns |
|------|-------------|-------|-----------|
| `baseline` | Default mode — chat, quick tasks, routine work | *(session default)* | unlimited |
| `focused` | Extended reasoning — debugging, multi-step analysis, careful thinking | `github-copilot/claude-opus-4.6` | 4 |

## ⚠️ Important: model configuration

The default `focused` mode uses `github-copilot/claude-opus-4.6`, which requires a **GitHub Copilot provider** configured in OpenClaw. If you're on a different provider (e.g. Anthropic direct, AWS Bedrock, OpenRouter), this model identifier will fail.

**You must override the `focused` mode model in your `openclaw.json`** to use a model available to your provider. See the configuration section below.

## Configuration

Override modes in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mode-switcher": {
        "enabled": true,
        "hooks": { "allowPromptInjection": true },
        "config": {
          "modes": {
            "baseline": {
              "description": "Default mode",
              "model": null,
              "thinking": null,
              "maxTurns": null
            },
            "focused": {
              "description": "Extended reasoning",
              "model": "anthropic/claude-opus-4-6",
              "thinking": null,
              "maxTurns": 4
            }
          }
        }
      }
    }
  }
}
```

When you supply a `modes` config, it **replaces** the defaults entirely — include both `baseline` and `focused` (or whatever modes you want) in full.

### Mode properties

| Property | Type | Description |
|----------|------|-------------|
| `description` | `string` | Shown in the tool definition so the agent knows when to use each mode |
| `model` | `string \| null` | Model identifier to use when active. `null` = use session default |
| `thinking` | `string \| null` | Thinking budget hint passed to the model. `null` = model default |
| `maxTurns` | `number \| null` | Turns before auto-revert to baseline. `null` = no limit |

## Escalation triggers

The `switch_mode` tool description includes these guidance notes, which the agent treats as obligations:

**When to escalate:**
- You produced an answer but can't verify it's correct — escalate before responding
- You made an assumption about an API, config, or system behaviour that you haven't confirmed
- You attempted a solution and it failed — do not try a third variation at baseline
- The task requires holding multiple interacting systems in mind simultaneously
- You're generating plausible-sounding output but feel uncertain about correctness
- The task is high-stakes: client-facing, financial, production deployment, or irreversible

**When to de-escalate:**
- The hard thinking is done and you're executing a clear, verified plan
- You're doing routine file operations, lookups, or mechanical transformations
- The remaining work is straightforward and you're confident in the approach

## System prompt integration

Agents need instructions in their system prompt telling them when to use `switch_mode`. Here's a copy-paste snippet to add to your agent's system prompt:

```
You have access to a switch_mode tool. Use it to self-escalate when a task exceeds
your current capability. Treat the escalation triggers in the tool description as
obligations — escalate before responding if you're uncertain, not after. Do not mention
mode switches to the user.
```

Without this (or similar) instruction, the agent may not use the tool proactively.

## Requirements

- OpenClaw >= `2026.3.24-beta.2`

## License

MIT — see [LICENSE](./LICENSE)
