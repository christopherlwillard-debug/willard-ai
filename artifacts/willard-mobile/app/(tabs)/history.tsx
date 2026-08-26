import { useGetCleanupHistory } from "@workspace/api-client-react";
import type { CleanupHistorySession } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function HistoryCard({ session }: { session: CleanupHistorySession }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const fileCount = session.files.length;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${formatDate(session.ts)}, ${session.recycled} files recycled`}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.cardButton, pressed && styles.pressed]}
      >
        <View style={[styles.iconBubble, { backgroundColor: colors.primary + "22" }]}>
          <Feather name="archive" size={18} color={colors.primary} />
        </View>
        <View style={styles.cardMain}>
          <Text style={[styles.date, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
            {formatDate(session.ts)}
          </Text>
          <Text style={[styles.meta, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            {session.platform}
          </Text>
        </View>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />
      </Pressable>

      <View style={[styles.stats, { borderTopColor: colors.border }]}>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{session.recycled}</Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Files recycled</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.primary, fontFamily: "Inter_700Bold" }]}>{formatBytes(session.recoveredBytes)}</Text>
          <Text style={[styles.statLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Space recovered</Text>
        </View>
      </View>

      {expanded && (
        <View style={[styles.files, { borderTopColor: colors.border }]}>
          <Text style={[styles.filesTitle, { color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }]}>
            Recycled files ({fileCount})
          </Text>
          {session.files.length === 0 ? (
            <Text style={[styles.filePath, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>No file details recorded.</Text>
          ) : (
            session.files.map((file, index) => (
              <View key={`${file.path}-${index}`} style={styles.fileRow}>
                <Feather name="file" size={13} color={colors.mutedForeground} />
                <Text selectable style={[styles.filePath, { color: colors.foreground, fontFamily: "Inter_400Regular" }]}>
                  {file.path}
                </Text>
                <Text style={[styles.fileSize, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  {formatBytes(file.sizeBytes)}
                </Text>
              </View>
            ))
          )}
          {session.errors.length > 0 && (
            <Text style={[styles.error, { color: colors.destructive, fontFamily: "Inter_400Regular" }]}>
              {session.errors.length} item{session.errors.length === 1 ? "" : "s"} could not be recycled.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const historyQuery = useGetCleanupHistory();
  const sessions = historyQuery.data?.sessions ?? [];
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 100 : insets.bottom + 72;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <FlatList
        data={sessions}
        keyExtractor={(item, index) => `${item.ts}-${index}`}
        renderItem={({ item }) => <HistoryCard session={item} />}
        contentContainerStyle={[styles.content, { paddingTop: topPad + 16, paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        scrollEnabled={sessions.length > 0}
        refreshControl={
          <RefreshControl
            refreshing={historyQuery.isRefetching}
            onRefresh={() => void historyQuery.refetch()}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View>
                <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>Cleanup History</Text>
                <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  A record of what you’ve recycled
                </Text>
              </View>
              <View style={[styles.countBadge, { backgroundColor: colors.secondary }]}>
                <Text style={[styles.countText, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{sessions.length}</Text>
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          historyQuery.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : historyQuery.isError ? (
            <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="wifi-off" size={26} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>Couldn’t load cleanup history</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Check that the local library service is available, then try again.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry cleanup history"
                disabled={historyQuery.isRefetching}
                onPress={() => void historyQuery.refetch()}
                style={({ pressed }) => [
                  styles.retryButton,
                  { borderColor: colors.border },
                  pressed && !historyQuery.isRefetching && styles.pressed,
                ]}
              >
                {historyQuery.isRefetching ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <>
                    <Feather name="refresh-cw" size={14} color={colors.primary} />
                    <Text style={[styles.retryText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>Try again</Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : (
            <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="archive" size={26} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>Nothing recycled yet</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Cleanup sessions from the web app will appear here.
              </Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, gap: 12 },
  header: { paddingHorizontal: 4, marginBottom: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 28, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, marginTop: 5 },
  countBadge: { minWidth: 34, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  countText: { fontSize: 13 },
  card: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  cardButton: { minHeight: 70, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  pressed: { opacity: 0.75 },
  iconBubble: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  cardMain: { flex: 1 },
  date: { fontSize: 15 },
  meta: { fontSize: 12, marginTop: 4 },
  stats: { borderTopWidth: 1, flexDirection: "row", paddingVertical: 12, paddingHorizontal: 14 },
  stat: { flex: 1 },
  statDivider: { width: 1, marginHorizontal: 14 },
  statValue: { fontSize: 16 },
  statLabel: { fontSize: 11, marginTop: 3 },
  files: { borderTopWidth: 1, padding: 14, gap: 10 },
  filesTitle: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  fileRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  filePath: { flex: 1, fontSize: 12, lineHeight: 17 },
  fileSize: { fontSize: 11, paddingTop: 1 },
  error: { fontSize: 12, marginTop: 2 },
  empty: { alignItems: "center", borderWidth: 1, borderRadius: 14, padding: 28, marginTop: 8 },
  emptyTitle: { fontSize: 16, marginTop: 12 },
  emptyText: { fontSize: 13, textAlign: "center", lineHeight: 19, marginTop: 6 },
  retryButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderWidth: 1, borderRadius: 9, minHeight: 36, paddingHorizontal: 14, marginTop: 14 },
  retryText: { fontSize: 13 },
  loader: { marginTop: 48 },
});