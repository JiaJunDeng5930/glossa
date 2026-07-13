import { glossGenerationIdentity, glossScanConfigHash } from "../core/cache";
import { trace } from "../shared/diagnostics";
import { diagnosticPayloadFrom } from "../shared/errors";
import { createGlossPortMessage, validateGlossPortInbound } from "../shared/messages";
import type { ExtensionStorage } from "../storage/db";
import type { GlossResolver } from "./glossResolver";

export interface GlossPortDependencies {
  storage: Pick<ExtensionStorage, "settings">;
  glossResolver: Pick<GlossResolver, "activateGeneration" | "createSession">;
}

export function attachGlossPort(
  port: chrome.runtime.Port,
  { storage, glossResolver }: GlossPortDependencies
): void {
  if (port.name !== "gloss.session") {
    return;
  }
  type PortState = "waiting" | "open" | "finishing" | "closed";
  let active = true;
  let state: PortState = "waiting";
  let session: ReturnType<typeof glossResolver.createSession> | undefined;
  let scanId: string | undefined;
  let pageUrl: string | undefined;
  let nextChunkIndex = 0;
  const acceptedChunkIds = new Set<string>();
  let commandQueue: Promise<void> | undefined;
  port.onDisconnect.addListener(() => {
    active = false;
    state = "closed";
  });
  port.onMessage.addListener((rawMessage: unknown) => {
    const runCommand = async (): Promise<void> => {
      if (!active || state === "closed") {
        return;
      }
      const message = validateGlossPortInbound(rawMessage);
      if (message.type === "gloss.scan.start") {
        if (state !== "waiting") {
          throw new Error("Gloss scan start received after session opened");
        }
        scanId = message.payload.scanId;
        pageUrl = message.payload.pageUrl;
        const startPayload = message.payload;
        const settings = await storage.settings.get();
        if (!active) {
          return;
        }
        if (startPayload.scanConfigHash !== glossScanConfigHash(settings)) {
          throw new Error("Gloss scan configuration is obsolete");
        }
        // Scan startup and the storage listener converge on one identity, independent of listener ordering.
        await glossResolver.activateGeneration(glossGenerationIdentity(settings));
        if (!active) {
          return;
        }
        session = glossResolver.createSession(startPayload.pageUrl, settings, Date.now(), {
          emit(outcome) {
            if (active) {
              safePost(port, createGlossPortMessage("gloss.token", {
                ...outcome,
                scanId: startPayload.scanId
              }));
            }
          },
          isActive() {
            return active;
          }
        });
        state = "open";
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: message.payload.pageUrl,
          details: { scanId: message.payload.scanId }
        });
        return;
      }
      if (message.type === "gloss.scan.chunk") {
        if (
          state !== "open"
          || !session
          || scanId !== message.payload.scanId
          || message.payload.chunkIndex !== nextChunkIndex
          || acceptedChunkIds.has(message.payload.chunkId)
        ) {
          throw new Error("Invalid gloss scan chunk sequence");
        }
        acceptedChunkIds.add(message.payload.chunkId);
        nextChunkIndex += 1;
        const acceptedTokens = message.payload.sentences.reduce((total, sentence) => total + sentence.tokens.length, 0);
        await session.acceptChunk(message.payload.chunkId, message.payload.chunkIndex, message.payload.sentences);
        if (!active) {
          return;
        }
        safePost(port, createGlossPortMessage("gloss.chunk.ack", {
          scanId: message.payload.scanId,
          chunkId: message.payload.chunkId,
          acceptedTokens
        }));
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: message.payload.pageUrl,
          details: {
            scanId: message.payload.scanId,
            chunkIndex: message.payload.chunkIndex,
            tokens: acceptedTokens,
            sentences: message.payload.sentences.length
          }
        });
        return;
      }
      if (message.type === "gloss.scan.end") {
        if (state !== "open" || !session || scanId !== message.payload.scanId) {
          throw new Error("Gloss scan end received outside an open session");
        }
        state = "finishing";
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: pageUrl,
          details: { scanId: message.payload.scanId }
        });
        await session.finish();
        if (!active) {
          return;
        }
        safePost(port, createGlossPortMessage("gloss.done", { scanId: message.payload.scanId }));
        state = "closed";
        return;
      }
    };
    commandQueue = (commandQueue ? commandQueue.then(runCommand) : runCommand()).catch((error) => {
      const scanId = scanIdFrom(rawMessage);
      trace({
        component: "service-worker",
        operation: "gloss.session",
        result: "error",
        error,
        ...(scanId ? { details: { scanId } } : {})
      });
      if (active) {
        safePost(port, createGlossPortMessage("gloss.error", {
          ...(scanId ? { scanId } : {}),
          ...diagnosticPayloadFrom(error, {
            reason: "runtime",
            message: "Gloss session failed",
            service: "runtime"
          })
        }));
      }
      active = false;
      state = "closed";
    });
  });
}

function safePost(port: chrome.runtime.Port, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // The content side closes obsolete scan ports during rescans and route changes.
  }
}

function scanIdFrom(value: unknown): string | undefined {
  if (
    typeof value === "object"
    && value !== null
    && "payload" in value
    && typeof value.payload === "object"
    && value.payload !== null
    && "scanId" in value.payload
    && typeof value.payload.scanId === "string"
  ) {
    return value.payload.scanId;
  }
  return undefined;
}
