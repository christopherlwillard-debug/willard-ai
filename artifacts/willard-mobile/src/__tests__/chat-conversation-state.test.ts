import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import type { OpenaiConversation } from "@workspace/api-client-react";
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  parseStoredConversationId,
  persistConversationId,
  restoreOrChooseConversation,
} from "../../lib/chat-conversation-state.ts";

function conversation(id: number, title = `Chat ${id}`): OpenaiConversation {
  return {
    id,
    title,
    createdAt: new Date(2026, 0, id).toISOString(),
  };
}

function makeStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

describe("mobile chat conversation selection", () => {
  test("persists the selected conversation ID when the user switches conversations", async () => {
    const storage = makeStorage();

    await persistConversationId(42, storage);

    assert.equal(await storage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY), "42");
  });

  test("restores the stored conversation when it still exists after restart", () => {
    const conversations = [conversation(42), conversation(17)];

    const storedId = parseStoredConversationId("42");

    assert.equal(restoreOrChooseConversation(storedId, conversations), 42);
  });

  test("falls back to the newest conversation when the stored one was deleted", () => {
    // The API contract returns conversations newest first.
    const conversations = [conversation(99), conversation(42)];

    const storedId = parseStoredConversationId("17");

    assert.equal(restoreOrChooseConversation(storedId, conversations), 99);
  });

  test("clears the saved selection when no conversation remains", async () => {
    const storage = makeStorage();
    await persistConversationId(42, storage);

    await persistConversationId(null, storage);

    assert.equal(await storage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY), null);
  });
});