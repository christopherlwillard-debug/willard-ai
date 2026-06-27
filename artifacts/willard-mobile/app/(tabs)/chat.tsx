import {
  useListOpenaiConversations,
  useCreateOpenaiConversation,
  useDeleteOpenaiConversation,
  useListOpenaiMessages,
} from "@workspace/api-client-react";
import type { OpenaiConversation, OpenaiMessage } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { fetch } from "expo/fetch";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

function timeLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type MessageBubbleProps = {
  message: OpenaiMessage;
  isStreaming?: boolean;
};

function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const colors = useColors();
  const isUser = message.role === "user";

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}>
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: colors.primary + "22", borderColor: colors.primary + "44" }]}>
          <Feather name="cpu" size={13} color={colors.primary} />
        </View>
      )}
      <View
        style={[
          styles.bubble,
          isUser
            ? { backgroundColor: colors.primary, maxWidth: "78%" }
            : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, maxWidth: "88%" },
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            {
              color: isUser ? "#fff" : colors.foreground,
              fontFamily: "Inter_400Regular",
            },
          ]}
        >
          {message.content}
          {isStreaming && (
            <Text style={{ color: colors.primary }}> ▋</Text>
          )}
        </Text>
        <Text
          style={[
            styles.bubbleTime,
            {
              color: isUser ? "rgba(255,255,255,0.6)" : colors.mutedForeground,
              fontFamily: "Inter_400Regular",
            },
          ]}
        >
          {timeLabel(message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [showConvPicker, setShowConvPicker] = useState(false);

  const streamingTextRef = useRef("");

  const conversationsQuery = useListOpenaiConversations();
  const conversations = conversationsQuery.data ?? [];

  const messagesQuery = useListOpenaiMessages(activeConvId!, {
    query: { enabled: !!activeConvId },
  });
  const messages: OpenaiMessage[] = messagesQuery.data ?? [];

  const createConvMutation = useCreateOpenaiConversation();
  const deleteConvMutation = useDeleteOpenaiConversation();

  useEffect(() => {
    if (!activeConvId && conversations.length > 0) {
      setActiveConvId(conversations[0].id);
    }
  }, [conversations, activeConvId]);

  const activeConv = conversations.find((c) => c.id === activeConvId);

  const createConversation = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    createConvMutation.mutate(
      { title: `Chat ${new Date().toLocaleDateString()}` },
      {
        onSuccess: (conv) => {
          void queryClient.invalidateQueries({ queryKey: ["/openai/conversations"] });
          setActiveConvId(conv.id);
          setShowConvPicker(false);
        },
      }
    );
  }, [createConvMutation, queryClient]);

  const deleteConversation = useCallback(
    async (convId: number) => {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      deleteConvMutation.mutate(
        { id: convId },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["/openai/conversations"] });
            if (activeConvId === convId) {
              const remaining = conversations.filter((c) => c.id !== convId);
              setActiveConvId(remaining.length > 0 ? remaining[0].id : null);
            }
          },
        }
      );
    },
    [deleteConvMutation, queryClient, activeConvId, conversations]
  );

  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !activeConvId || isSending) return;

    setInputText("");
    setIsSending(true);
    streamingTextRef.current = "";
    setStreamingText("");

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const resp = await fetch(
        `https://${process.env.EXPO_PUBLIC_DOMAIN}/api/openai/conversations/${activeConvId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        }
      );

      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data) as { content?: string };
              if (chunk.content) {
                streamingTextRef.current += chunk.content;
                setStreamingText(streamingTextRef.current);
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      console.error("Stream error:", err);
    } finally {
      setIsSending(false);
      streamingTextRef.current = "";
      setStreamingText("");
      void queryClient.invalidateQueries({ queryKey: [`/openai/conversations/${activeConvId}/messages`] });
      void messagesQuery.refetch();
    }
  }, [inputText, activeConvId, isSending, queryClient, messagesQuery]);

  const streamingMsg: OpenaiMessage | null = streamingText
    ? {
        id: -1,
        conversationId: activeConvId!,
        role: "assistant",
        content: streamingText,
        createdAt: new Date().toISOString(),
      }
    : null;

  const displayMessages: OpenaiMessage[] = streamingMsg
    ? [streamingMsg, ...messages]
    : messages;

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: topPad + 12,
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable
          onPress={() => setShowConvPicker(true)}
          style={styles.convSelector}
        >
          <Text
            style={[styles.convTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}
            numberOfLines={1}
          >
            {activeConv?.title ?? "No conversation"}
          </Text>
          <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
        </Pressable>
        <Pressable
          onPress={createConversation}
          style={[styles.newChatBtn, { backgroundColor: colors.primary + "22", borderColor: colors.primary + "44" }]}
          testID="new-chat-button"
        >
          <Feather name="plus" size={18} color={colors.primary} />
        </Pressable>
      </View>

      {/* Messages */}
      {!activeConvId ? (
        <View style={styles.emptyState}>
          <Feather name="message-circle" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            No conversations yet
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Tap + to start chatting with your NAS
          </Text>
        </View>
      ) : messagesQuery.isLoading ? (
        <View style={styles.emptyState}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList<OpenaiMessage>
          data={displayMessages}
          inverted
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              isStreaming={item.id === -1 && isSending}
            />
          )}
          contentContainerStyle={[
            styles.messageList,
            { paddingBottom: 16 },
          ]}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!!displayMessages.length}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Feather name="message-square" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Ask anything about your NAS
              </Text>
            </View>
          }
        />
      )}

      {/* Input bar */}
      <View
        style={[
          styles.inputBar,
          {
            backgroundColor: colors.background,
            borderTopColor: colors.border,
            paddingBottom: bottomInset + 8,
          },
        ]}
      >
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              color: colors.foreground,
              fontFamily: "Inter_400Regular",
            },
          ]}
          placeholder="Ask about your NAS…"
          placeholderTextColor={colors.mutedForeground}
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={2000}
          editable={!!activeConvId && !isSending}
          returnKeyType="send"
          onSubmitEditing={sendMessage}
          testID="chat-input"
        />
        <Pressable
          onPress={sendMessage}
          disabled={!inputText.trim() || !activeConvId || isSending}
          style={({ pressed }) => [
            styles.sendBtn,
            {
              backgroundColor:
                !inputText.trim() || !activeConvId || isSending
                  ? colors.muted
                  : colors.primary,
              opacity: pressed ? 0.75 : 1,
            },
          ]}
          testID="send-button"
        >
          {isSending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Feather name="arrow-up" size={18} color="#fff" />
          )}
        </Pressable>
      </View>

      {/* Conversation picker modal */}
      <Modal
        visible={showConvPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowConvPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowConvPicker(false)}>
          <View
            style={[
              styles.modalSheet,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={[styles.modalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                Conversations
              </Text>
              <Pressable
                onPress={createConversation}
                style={[styles.modalNewBtn, { borderColor: colors.primary }]}
              >
                <Feather name="plus" size={15} color={colors.primary} />
                <Text style={[styles.modalNewText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                  New Chat
                </Text>
              </Pressable>
            </View>

            {conversationsQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 20 }} />
            ) : conversations.length === 0 ? (
              <Text style={[styles.emptySubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", padding: 24 }]}>
                No conversations yet
              </Text>
            ) : (
              <FlatList<OpenaiConversation>
                data={conversations}
                keyExtractor={(c) => String(c.id)}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => {
                      setActiveConvId(item.id);
                      setShowConvPicker(false);
                    }}
                    style={[
                      styles.convRow,
                      {
                        backgroundColor:
                          item.id === activeConvId
                            ? colors.primary + "18"
                            : "transparent",
                        borderBottomColor: colors.border,
                      },
                    ]}
                  >
                    <Feather
                      name="message-square"
                      size={16}
                      color={item.id === activeConvId ? colors.primary : colors.mutedForeground}
                    />
                    <Text
                      style={[
                        styles.convRowText,
                        {
                          color: item.id === activeConvId ? colors.primary : colors.foreground,
                          fontFamily: "Inter_500Medium",
                          flex: 1,
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {item.title}
                    </Text>
                    <Pressable
                      onPress={() => void deleteConversation(item.id)}
                      hitSlop={12}
                    >
                      <Feather name="trash-2" size={15} color={colors.mutedForeground} />
                    </Pressable>
                  </Pressable>
                )}
                style={{ maxHeight: 360 }}
                scrollEnabled
              />
            )}
            <View style={{ height: insets.bottom + 8 }} />
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  convSelector: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  convTitle: {
    fontSize: 17,
    letterSpacing: -0.3,
    flex: 1,
  },
  newChatBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  messageList: {
    paddingHorizontal: 14,
    paddingTop: 12,
    flexGrow: 1,
  },
  bubbleRow: {
    flexDirection: "row",
    marginVertical: 4,
    alignItems: "flex-end",
    gap: 8,
  },
  bubbleRowUser: {
    justifyContent: "flex-end",
  },
  bubbleRowAssistant: {
    justifyContent: "flex-start",
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    gap: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTime: {
    fontSize: 10,
    alignSelf: "flex-end",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 10,
  },
  input: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 12,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 14,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 17,
  },
  modalNewBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  modalNewText: {
    fontSize: 13,
  },
  convRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  convRowText: {
    fontSize: 15,
  },
});
