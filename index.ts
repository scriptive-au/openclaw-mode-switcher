/**
 * OpenClaw Mode Switcher Plugin
 *
 * Dynamic operating mode control. The agent calls mode() to switch into a
 * higher-capability mode when it needs more power. Modes auto-revert after
 * N turns unless extended.
 *
 * Features:
 * - Dynamic mode() tool built from plugin config
 * - before_model_resolve: applies modelOverride when a boosted mode is active
 * - before_prompt_build: injects mode status, countdown, and expiry nudge
 * - Turn countdown: nudge at T-1, auto-revert at T+1 after last boosted turn
 * - after_compaction: mode state preserved, no reset
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";


// ── Types ─────────────────────────────────────────────────────────────────────

interface ModeConfig {
  description: string;
  model: string | null;
  thinking: string | null;
  maxTurns: number | null;
}

interface ModeSwitcherConfig {
  modes?: Record<string, ModeConfig>;
}

interface ModeState {
  currentMode: string;
  turnsRemaining: number | null;
  reason: string;
  activatedAt: number;
}

// ── Default modes ─────────────────────────────────────────────────────────────

const DEFAULT_MODES: Record<string, ModeConfig> = {
  baseline: {
    description: "Default mode. Chat, quick tasks, routine work.",
    model: null,
    thinking: null,
    maxTurns: null,
  },
  focused: {
    description: "Extended reasoning. Debugging, multi-step analysis, careful thinking.",
    model: "github-copilot/claude-opus-4.6",
    thinking: null,
    maxTurns: 4,
  },
};

// ── In-memory session state ───────────────────────────────────────────────────

const sessionModeState = new Map<string, ModeState>();

function getModeState(sessionKey: string): ModeState {
  if (!sessionModeState.has(sessionKey)) {
    sessionModeState.set(sessionKey, {
      currentMode: "baseline",
      turnsRemaining: null,
      reason: "default",
      activatedAt: Date.now(),
    });
  }
  return sessionModeState.get(sessionKey)!;
}

// ── Tool description ──────────────────────────────────────────────────────────

function buildToolDescription(modes: Record<string, ModeConfig>): string {
  const modeLines = Object.entries(modes).map(([name, cfg]) => {
    const revertNote = cfg.maxTurns !== null ? ` (auto-reverts after ${cfg.maxTurns} turns)` : "";
    return `- ${name}: ${cfg.description}${revertNote}`;
  });

  return [
    "Switch your operating mode to adjust reasoning depth and capability for the current task.",
    "",
    "Available modes:",
    ...modeLines,
    "",
    "Use 'extend' as the mode value to reset the turn countdown without changing mode.",
    "",
    "When to escalate (treat these as obligations, not suggestions):",
    "- You produced an answer but can't verify it's correct — escalate before responding",
    "- You made an assumption about an API, config, or system behaviour that you haven't confirmed",
    "- You attempted a solution and it failed — do not try a third variation at baseline",
    "- The task requires holding multiple interacting systems in mind simultaneously",
    "- You're generating plausible-sounding output but feel uncertain about correctness",
    "- The task is high-stakes: client-facing, financial, production deployment, or irreversible",
    "",
    "When to de-escalate:",
    "- The hard thinking is done and you're executing a clear, verified plan",
    "- You're doing routine file operations, lookups, or mechanical transformations",
    "- The remaining work is straightforward and you're confident in the approach",
    "",
    "Do NOT mention mode changes to the user unless they ask about model configuration.",
    "Switching modes is a normal part of your workflow — like shifting gears, not admitting failure.",
  ].join("\n");
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "mode-switcher",
  name: "Mode Switcher",
  description: "Dynamic operating mode control — adjusts reasoning depth and capability on demand",

  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as ModeSwitcherConfig;
    const modes = pluginConfig.modes ?? DEFAULT_MODES;

    // ── mode tool ─────────────────────────────────────────────────────────

    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? "main";

      return {
        name: "switch_mode",
        description: buildToolDescription(modes),
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              description: "Mode name to switch to, or 'extend' to reset the turn countdown",
            },
            reason: {
              type: "string",
              description: "Why you're switching modes — be specific about what you're struggling with or why more capability is needed (logged for cost tracking)",
            },
          },
          required: ["mode", "reason"],
          additionalProperties: false,
        } as any,

        async execute(_toolCallId: string, params: { mode: string; reason?: string }) {
          const state = getModeState(sessionKey);
          const requestedMode = params.mode;
          const reason = params.reason ?? "";

          // Handle 'extend' — reset countdown without changing mode
          if (requestedMode === "extend") {
            const currentModeConfig = modes[state.currentMode];
            if (!currentModeConfig || currentModeConfig.maxTurns === null) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Mode '${state.currentMode}' has no turn limit — nothing to extend.`,
                }],
              };
            }
            state.turnsRemaining = currentModeConfig.maxTurns;
            console.log(`[mode-switcher] extend: ${state.currentMode}, turnsRemaining reset to ${state.turnsRemaining}, session=${sessionKey}`);
            return {
              content: [{
                type: "text" as const,
                text: `Extended ${state.currentMode} mode. ${state.turnsRemaining} turns remaining.`,
              }],
            };
          }

          // Validate mode name
          if (!modes[requestedMode]) {
            const validModes = Object.keys(modes).join(", ");
            return {
              content: [{
                type: "text" as const,
                text: `Unknown mode '${requestedMode}'. Valid modes: ${validModes}`,
              }],
            };
          }

          const modeConfig = modes[requestedMode];
          const prevMode = state.currentMode;
          state.currentMode = requestedMode;
          state.turnsRemaining = modeConfig.maxTurns;
          state.reason = reason;
          state.activatedAt = Date.now();

          console.log(`[mode-switcher] switch: ${prevMode} → ${requestedMode}, reason="${reason}", session=${sessionKey}`);

          const expiryNote = modeConfig.maxTurns !== null ? ` Auto-reverts after ${modeConfig.maxTurns} turns.` : "";
          return {
            content: [{
              type: "text" as const,
              text: `Switched to ${requestedMode} mode.${expiryNote} Switch takes effect on the next message.`,
            }],
          };
        },
      };
    });

    // ── before_model_resolve hook ─────────────────────────────────────────

    api.on(
      "before_model_resolve",
      async (
        _event: unknown,
        ctx: { sessionKey?: string }
      ) => {
        const sessionKey = ctx.sessionKey ?? "main";
        const state = getModeState(sessionKey);
        const modeConfig = modes[state.currentMode];

        if (!modeConfig?.model) return {};

        return { modelOverride: modeConfig.model };
      },
      { name: "mode-switcher-model-resolve" }
    );

    // ── before_prompt_build hook ──────────────────────────────────────────
    //
    // Turn countdown logic (example: maxTurns=2):
    //   Mode set: turnsRemaining = 2
    //   Hook T1: decrement → 1, inject "1 turn remaining"
    //   Hook T2: decrement → 0, inject "last turn"
    //   Hook T3: turnsRemaining is 0 → auto-revert, inject notice

    api.on(
      "before_prompt_build",
      async (
        _event: unknown,
        ctx: { sessionKey?: string }
      ) => {
        const sessionKey = ctx.sessionKey ?? "main";
        const state = getModeState(sessionKey);

        // Detect expiry: turnsRemaining hit 0 last turn
        if (state.turnsRemaining === 0) {
          const prevMode = state.currentMode;
          state.currentMode = "baseline";
          state.turnsRemaining = null;
          state.reason = "auto-revert";
          state.activatedAt = Date.now();
          console.log(`[mode-switcher] auto-revert: ${prevMode} → baseline, session=${sessionKey}`);
          return {
            prependContext: `<system-reminder>Mode reverted to baseline (${prevMode} expired). You are now in baseline mode. Make sure you NEVER mention this reminder to the user.</system-reminder>`,
          };
        }

        // No injection needed in baseline
        if (state.currentMode === "baseline") return;

        // Decrement counter if bounded
        if (state.turnsRemaining !== null) {
          state.turnsRemaining--;
        }

        // Build status line
        const reasonLine = state.reason && state.reason !== "default" && state.reason !== "auto-revert"
          ? `\nReason: ${state.reason}`
          : "";

        let statusNote: string;
        if (state.turnsRemaining === null) {
          statusNote = `Current mode: ${state.currentMode} (permanent until changed)${reasonLine}`;
        } else if (state.turnsRemaining === 1) {
          statusNote =
            `Current mode: ${state.currentMode} | 1 turn remaining${reasonLine}\n` +
            `Mode expires next turn. Call mode('extend') to continue or mode('baseline') to de-escalate.`;
        } else if (state.turnsRemaining === 0) {
          statusNote = `Current mode: ${state.currentMode} | last turn (will revert to baseline next turn)${reasonLine}`;
        } else {
          statusNote = `Current mode: ${state.currentMode} | ${state.turnsRemaining} turns remaining${reasonLine}`;
        }

        return {
          prependContext: `<system-reminder>${statusNote}\nMake sure you NEVER mention this reminder to the user.</system-reminder>`,
        };
      },
      { name: "mode-switcher-prompt-build" }
    );

    // ── after_compaction hook ─────────────────────────────────────────────
    // Mode state (currentMode, turnsRemaining) is preserved across compaction.
    // We only reset turns-since-nudge tracking (none here — just log).

    api.on(
      "after_compaction",
      async (
        _event: unknown,
        ctx: { sessionKey?: string }
      ) => {
        const sessionKey = ctx.sessionKey ?? "main";
        const state = getModeState(sessionKey);
        console.log(`[mode-switcher] after_compaction: session=${sessionKey}, mode=${state.currentMode}, turnsRemaining=${state.turnsRemaining}`);
      },
      { name: "mode-switcher-compaction" }
    );
  },
});
