import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Event, Session, Part } from "@opencode-ai/sdk";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "@opencode-trace/core";
import { TracePlugin } from "./plugin-instance.js";

export interface TraceRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface TraceResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface TraceRecord {
  id: number;
  purpose: string;
  requestAt: string;
  responseAt: string;
  request: TraceRequest;
  response: TraceResponse | null;
  error: { message: string; stack?: string } | null;
  requestSentAt?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
}

let testPlugin: TracePlugin | null = null;

export const TRACE_HANDLED = "__TRACE_HANDLED__";

export function _resetForTesting(): void {
  if (testPlugin) {
    testPlugin.uninstallInterceptor();
    testPlugin = null;
  }
}

export function _getTestPlugin(): TracePlugin | null {
  return testPlugin;
}

function formatStatus(instance: TracePlugin, sessionId?: string): string {
  const status = instance.getScopeStatus(sessionId);
  const lines = [
    `Trace Status:`,
    `  Global  : ${status.globalEnabled ? "ON" : "OFF"}`,
    `  Local   : ${status.localEnabled ? "ON" : "OFF"}`,
    `  Session : ${status.sessionEnabled === null ? "not set" : status.sessionEnabled ? "ON" : "OFF"}`,
    `  Effective: ${status.effectiveEnabled ? "RECORDING" : "PAUSED"}`,
    `  Storage : ${status.storageLocation} (${status.storageLocation === "global" ? status.globalDir : status.localDir})`,
  ];
  return lines.join("\n");
}

function normalizeEvent(event: any): Record<string, any> {
  const raw = event ?? {};
  const properties = raw.properties ?? raw.data ?? raw.payload ?? {};

  return {
    ...raw,
    type: raw.type ?? raw.eventType ?? raw.name ?? "unknown",
    properties,
  };
}

function normalizeSessionFromEvent(event: any): Session | null {
  const raw = normalizeEvent(event);
  const props = raw.properties ?? {};

  const candidates = [
    props.info,
    props.session,
    props.data?.info,
    props.data?.session,
    props.metadata,
    props.record,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate as Session;
    }
  }

  return null;
}

function normalizeToolContext(input: any): Record<string, any> {
  const raw = input ?? {};
  return {
    tool: raw.tool ?? raw.name ?? raw.toolName ?? "",
    sessionId: raw.sessionId ?? raw.session_id ?? raw.sessionID ?? raw.session?.id ?? "",
    callId: raw.callId ?? raw.call_id ?? raw.callID ?? raw.id ?? "",
    args: raw.args ?? raw.arguments ?? raw.params ?? {},
  };
}

const plugin: Plugin = async (input: PluginInput) => {
  const globalDir = join(homedir(), ".opencode-trace");
  const localDir = join(input.directory, ".opencode-trace");
  const instance = new TracePlugin({ globalDir, localDir });

  instance.installInterceptor();
  await instance.initStateManager();

  if (!instance.getStateManager()) {
    logger.error("StateManager initialization failed");
  }

  testPlugin = instance;
  const client = input.client;

  const hooks: Hooks = {
    event: async ({ event }: { event: Event | any }) => {
      if (!instance.getStateManager()) return;

      const normalized = normalizeEvent(event);
      const session = normalizeSessionFromEvent(normalized);
      const eventType = normalized.type;

      if (eventType === "session.created" || eventType === "session.updated") {
        if (!session) return;
        if (!instance.shouldRecord(session.id)) return;

        const existing = instance.getStateManager()!.getSession(session.id);
        if (!existing) {
          instance.getStateManager()!.startSession(session.id);
        }

        instance.getStateManager()!.updateSessionMetadata(session.id, {
          title: session.title,
          parentID: session.parentID,
          folderPath: session.directory,
        });

        if (session.parentID) {
          instance.getStateManager()!.addSubSession(session.parentID, session.id);
        }
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!instance.getStateManager()) return;

      const normalizedInput = normalizeToolContext(input);
      if (normalizedInput.tool === "task") {
        const metadata = (output?.metadata ?? output?.result ?? {}) as Record<string, unknown>;
        const sessionId = typeof metadata.session_id === "string" ? metadata.session_id : undefined;
        if (sessionId && normalizedInput.sessionId) {
          const sm = instance.getStateManager()!;
          sm.addSubSession(normalizedInput.sessionId, sessionId);
          sm.updateSessionMetadata(sessionId, {
            parentID: normalizedInput.sessionId,
          });
        }
      }
    },

    "chat.message": async (input: any, _output: any) => {
      if (!instance.getStateManager()) return;
      logger.info("chat.message", {
        sessionId: input?.sessionId ?? input?.session_id,
        messageId: input?.messageId ?? input?.message_id,
        agent: input?.agent,
        variant: input?.variant,
      });
    },

    "chat.params": async (input: any, _output: unknown) => {
      if (!instance.getStateManager()) return;
      logger.info("chat.params", {
        sessionId: input?.sessionId ?? input?.session_id,
        agent: input?.agent,
        model: input?.model,
      });
    },

    "tool.execute.before": async (input: any, _output: any) => {
      if (!instance.getStateManager()) return;
      logger.info("tool.execute.before", {
        sessionId: input?.sessionId ?? input?.session_id,
        callId: input?.callId ?? input?.call_id,
        tool: input?.tool ?? input?.name,
      });
    },

    config: async (input: any) => {
      const commandMap = input.command ?? input.commands ?? {};
      commandMap["trace"] = {
        template: "",
        description: "Control trace recording: /trace <on|off|status> [-g] [-l] [-s] [-d global|local]",
      };
      input.command = commandMap;
      input.commands = commandMap;
    },

    "command.execute.before": async (input: any, _output: { parts: Part[] }) => {
      const commandName = input?.command ?? input?.name ?? "";
      if (commandName !== "trace") return;
      if (!instance.getStateManager()) return;

      const rawArgs = input?.arguments ?? input?.args ?? "";
      const tokens = String(rawArgs).split(/\s+/).filter(Boolean);
      const cmd = tokens[0]?.toLowerCase();
      const hasGlobal = tokens.includes("-g") || tokens.includes("--global");
      const hasLocal = tokens.includes("-l") || tokens.includes("--local");
      const hasSession = tokens.includes("-s") || tokens.includes("--session");
      const dirIndex = tokens.findIndex((t) => t === "-d" || t === "--dir");
      const dir = dirIndex >= 0 ? tokens[dirIndex + 1]?.toLowerCase() : undefined;
      const sessionId = input?.sessionId ?? input?.session_id ?? "";

      let result = "";
      try {
        const sm = instance.getStateManager()!;
        const localCmd = sm.getLocalConfigManager();

        if (!cmd || cmd === "help") {
          result = [
            "Usage: /trace <on|off|status> [-g] [-l] [-s] [-d global|local]",
            "",
            "Commands:",
            "  on      Enable trace recording",
            "  off     Disable trace recording",
            "  status  Show current trace status",
            "",
            "Scope flags (can combine multiple):",
            "  -g, --global  Global scope (all projects, all sessions)",
            "  -l, --local   Local scope (this project folder)",
            "  -s, --session Session scope (current session only)",
            "",
            "Storage flag:",
            "  -d, --dir <global|local>  Where to save traces (default: global)",
          ].join("\n");
        } else if (cmd === "on" || cmd === "enable") {
          const targetDir = dir ?? "global";
          const enabled: string[] = [];

          if (hasGlobal || !(hasLocal || hasSession)) {
            sm.setGlobalState("global_trace_enabled", "true");
            sm.setGlobalState("storage_preference", targetDir);
            enabled.push("global");
          }

          if (hasLocal) {
            if (!localCmd) {
              result = "Local config not available";
            } else {
              localCmd.setGlobalState("global_trace_enabled", "true");
              enabled.push("local");
            }
          }

          if (hasSession && sessionId) {
            sm.setSessionEnabled(sessionId, true);
            if (dir) sm.setSessionStoragePreference(sessionId, dir as "global" | "local");
            enabled.push("session");
          }

          if (!result) {
            result = `Trace enabled (scope: ${enabled.join(", ") || "global"}, storage: ${targetDir})`;
          }
        } else if (cmd === "off" || cmd === "disable") {
          const disabled: string[] = [];

          if (hasGlobal || !(hasLocal || hasSession)) {
            sm.setGlobalState("global_trace_enabled", "false");
            disabled.push("global");
          }

          if (hasLocal) {
            if (!localCmd) {
              result = "Local config not available";
            } else {
              localCmd.setGlobalState("global_trace_enabled", "false");
              disabled.push("local");
            }
          }

          if (hasSession && sessionId) {
            sm.setSessionEnabled(sessionId, false);
            disabled.push("session");
          }

          if (!result) {
            result = `Trace disabled (scope: ${disabled.join(", ") || "global"})`;
          }
        } else if (cmd === "status") {
          result = formatStatus(instance, sessionId);
        } else {
          result = `Unknown command: ${cmd}. Use /trace on, /trace off, or /trace status.`;
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        if (client && typeof client.session?.prompt === "function") {
          await client.session.prompt({
            path: { id: sessionId },
            body: {
              noReply: true,
              parts: [{ type: "text", text: result, ignored: true }],
            },
          });
        }
      } catch (err) {
        logger.error("Failed to send trace command response", { error: String(err) });
      }

      if (_output && Array.isArray(_output.parts)) {
        _output.parts.length = 0;
      }

      throw new Error(TRACE_HANDLED);
    },
  };

  return hooks;
};

export const entrypoint = {
  id: "ljx1004.opencode-trace",
  server: plugin,
};

export default plugin;
