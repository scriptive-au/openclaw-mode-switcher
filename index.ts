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
 * - before_prompt_build: injects expiry warning at T-2, revert notice at T-0
 * - Turn countdown: nudge at T-2, auto-revert when turnsRemaining hits 0
 * - after_compaction: mode state preserved, no reset
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";


// ── Types ─────────────────────────────────────────────────────────────────────

interface ModeConfig {
  description: string;
  model: string | null;
  provider: string | null;
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
    provider: null,
    thinking: null,
    maxTurns: null,
  },
  focused: {
    description: "Extended reasoning. Debugging, multi-step analysis, careful thinking.",
    model: "claude-opus-4.6",
    provider: "anthropic",
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

          console.log(`[mode-switcher] ${prevMode} → ${requestedMode}, session=${sessionKey}`);

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

        if (!modeConfig?.model && !modeConfig?.provider) return {};

        // model and provider are taken as-is from config — no combined "provider/model" parsing
        const result: Record<string, string> = {};
        if (modeConfig.model) result.modelOverride = modeConfig.model;
        if (modeConfig.provider) result.providerOverride = modeConfig.provider;
        return result;
      },
      { name: "mode-switcher-model-resolve" }
    );

    // ── before_prompt_build hook ──────────────────────────────────────────
    //
    // Turn countdown logic (example: maxTurns=4):
    //   Mode set: turnsRemaining = 4
    //   Hook T1: decrement → 3, no injection (model knows from tool response)
    //   Hook T2: decrement → 2, inject T-2 warning
    //   Hook T3: decrement → 1, no injection
    //   Hook T4: decrement → 0, no injection (last boosted turn)
    //   Hook T5: turnsRemaining is 0 → auto-revert, inject notice

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
          console.log(`[mode-switcher] auto-revert: ${prevMode} → baseline`);
          return {
            prependContext: `<system-reminder>Mode reverted to baseline (${prevMode} expired). You are now in baseline mode. Make sure you NEVER mention this reminder to the user.</system-reminder>`,
          };
        }

        // No injection needed in baseline
        if (state.currentMode === "baseline") return {};

        // Decrement counter if bounded
        if (state.turnsRemaining !== null) {
          state.turnsRemaining--;
        }

        // Only inject at T-2 — warn agent so it can extend before expiry
        if (state.turnsRemaining === 2) {
          return {
            prependContext: `<system-reminder>Mode expires in 2 turns. Call switch_mode('extend', 'reason') to continue, or let it revert. Make sure you NEVER mention this reminder to the user.</system-reminder>`,
          };
        }

        return {};
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
        console.log(`[mode-switcher] compaction: mode=${state.currentMode}, turns=${state.turnsRemaining}`);
      },
      { name: "mode-switcher-compaction" }
    );
  },
});
