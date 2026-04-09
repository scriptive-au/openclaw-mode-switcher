# openclaw-mode-switcher

Give your OpenClaw agent a `switch_mode` tool so it can self-escalate to a more capable model when it needs one — then automatically revert when the hard part is done.

- `switch_mode(mode, reason)` to upgrade capability mid-conversation
- `before_model_resolve` hook overrides the active model for boosted turns
- `before_prompt_build` injects a live countdown so the agent tracks its remaining turns
- Auto-reverts to baseline after N turns — no manual reset needed
- `extend` pseudo-mode resets the countdown without changing mode
- State survives compaction via `after_compaction` hook
- Fully configurable: define your own modes, models, and turn limits

---

## Install

```
openclaw plugins install clawhub:openclaw-mode-switcher
```

---

## How it works

The plugin registers a `switch_mode` tool the agent can call at any point. When called:

1. The plugin records the new mode in session state
2. On the next turn, `before_model_resolve` applies the mode's model override
3. `before_prompt_build` prepends a status reminder with turns remaining
4. After `maxTurns` turns, the mode auto-reverts to baseline

The agent also accepts `extend` as the mode value to reset the countdown without switching modes.

---

## Configuration

Add to your `~/.openclaw/openclaw.json`. Define as many modes as you need — point each one at any model your OpenClaw instance has access to.

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
              "description": "Default mode. Chat, quick tasks, routine work.",
              "model": null,
              "maxTurns": null
            },
            "focused": {
              "description": "Extended reasoning. Debugging, multi-step analysis, careful thinking.",
              "model": "anthropic/claude-opus-4-6",
              "maxTurns": 4
            }
          }
        }
      }
    }
  }
}
```

> `allowPromptInjection: true` is required — without it the mode status reminder won't be injected into prompts.

**Mode config fields:**

| Field | Type | Description |
|---|---|---|
| `description` | string | Shown in the tool definition the agent sees |
| `model` | string \| null | Model to use when this mode is active. `null` = session default |
| `maxTurns` | number \| null | Turns before auto-reverting to baseline. `null` = no limit |

A mode with `model: null` uses the session's default model — useful for a mode that changes behaviour via the system prompt only.

---

## System prompt integration

The plugin registers the tool automatically, but your agent needs guidance on *when* to use it. Add something like this to your `AGENTS.md`:

```markdown
## Operating Modes

Use `switch_mode` to adjust reasoning depth for the current task.

**Escalate when:**
- You produced an answer but can't verify it's correct
- You made an assumption about an API, config, or behaviour you haven't confirmed
- A solution failed and you don't want to guess at a third variation
- The task requires holding multiple interacting systems in mind simultaneously
- The work is high-stakes — client-facing, financial, production, or irreversible

**De-escalate when:**
- The hard thinking is done and you're executing a clear plan
- You're doing routine file ops, lookups, or mechanical transformations

Do NOT mention mode changes to the user. Switching modes is like shifting gears — not admitting failure.
```

---

## Requirements

- OpenClaw >= `2026.3.24-beta.2`
- Plugin API >= `2026.3.24-beta.2`

---

## License

MIT — [Roman Yakobnyuk / Scriptive](https://scriptive.com.au)
