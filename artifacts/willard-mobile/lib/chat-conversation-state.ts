import type { OpenaiConversation } from "@workspace/api-client-react";

export const ACTIVE_CONVERSATION_STORAGE_KEY = "willard.activeConversationId";

export interface ConversationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function parseStoredConversationId(storedId: string | null): number | null {
  if (storedId === null) return null;
  const parsedId = Number(storedId);
  return Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
}

export function restoreOrChooseConversation(
  storedId: number | null,
  conversations: OpenaiConversation[],
): number | null {
  if (storedId !== null && conversations.some((conversation) => conversation.id === storedId)) {
    return storedId;
  }
  return conversations[0]?.id ?? null;
}

export async function persistConversationId(
  conversationId: number | null,
  storage: ConversationStorage,
): Promise<void> {
  if (conversationId === null) {
    await storage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } else {
    await storage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, String(conversationId));
  }
}