import { createAnkiClient } from "./anki";
import { createAiBackend } from "./ai";
import { createBackgroundMessageHandler } from "./messages";
import { createExtensionStorage } from "../storage/db";
import type { ContentToBackgroundMessage } from "../shared/types";

const handleMessage = createBackgroundMessageHandler({
  storage: createExtensionStorage(),
  ai: createAiBackend(),
  anki: createAnkiClient()
});

chrome.runtime.onMessage.addListener((message: ContentToBackgroundMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse);
  return true;
});
