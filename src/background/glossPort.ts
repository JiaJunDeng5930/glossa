import { glossGenerationIdentity } from "../core/cache";
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
  let active = true;
  let session: ReturnType<typeof glossResolver.createSession> | undefined;
  let sessionPromise: Promise<ReturnType<typeof glossResolver.createSession>> | undefined;
  let scanId: string | undefined;
  let pageUrl: string | undefined;
  port.onDisconnect.addListener(() => {
    active = false;
  });
  port.onMessage.addListener((rawMessage: unknown) => {
    void (async () => {
      const message = validateGlossPortInbound(rawMessage);
      if (message.type === "gloss.scan.start") {
        scanId = message.payload.scanId;
        pageUrl = message.payload.pageUrl;
        const startPayload = message.payload;
        sessionPromise = storage.settings.get().then(async (settings) => {
          // Scan startup and the storage listener converge on one identity, independent of listener ordering.
          const generationGate = glossResolver.activateGeneration(glossGenerationIdentity(settings));
          const createdSession = glossResolver.createSession(startPayload.pageUrl, settings, Date.now(), {
            emit(outcome) {
              safePost(port, createGlossPortMessage("gloss.token", {
                ...outcome,
                scanId: startPayload.scanId
              }));
            },
            isActive() {
              return active;
            }
          });
          await generationGate;
          return createdSession;
        });
        session = await sessionPromise;
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
        if (!sessionPromise || scanId !== message.payload.scanId) {
          throw new Error("Gloss scan chunk received before scan start");
        }
        session = await sessionPromise;
        const acceptedTokens = message.payload.sentences.reduce((total, sentence) => total + sentence.tokens.length, 0);
        await session.acceptChunk(message.payload.chunkId, message.payload.chunkIndex, message.payload.sentences);
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
        if (!sessionPromise || scanId !== message.payload.scanId) {
          throw new Error("Gloss scan end received before scan start");
        }
        session = await sessionPromise;
        trace({
          component: "service-worker",
          operation: message.type,
          result: "ok",
          url: pageUrl,
          details: { scanId: message.payload.scanId }
        });
        await session.finish();
        safePost(port, createGlossPortMessage("gloss.done", { scanId: message.payload.scanId }));
        return;
      }
    })().catch((error) => {
      const scanId = scanIdFrom(rawMessage);
      trace({
        component: "service-worker",
        operation: "gloss.session",
        result: "error",
        error,
        ...(scanId ? { details: { scanId } } : {})
      });
      safePost(port, createGlossPortMessage("gloss.error", {
        ...(scanId ? { scanId } : {}),
        ...diagnosticPayloadFrom(error, {
          reason: "runtime",
          message: "Gloss session failed",
          service: "runtime"
        })
      }));
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
