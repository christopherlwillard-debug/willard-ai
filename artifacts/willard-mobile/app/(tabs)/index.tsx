import {
  useGetDashboard,
  useGetScanStatus,
  useStartScan,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type StatCardProps = {
  label: string;
  value: string;
  icon: keyof typeof Feather.glyphMap;
  accent: string;
};

function StatCard({ label, value, icon, accent }: StatCardProps) {
  const colors = useColors();
  return (
    <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.statIconBg, { backgroundColor: accent + "22" }]}>
        <Feather name={icon} size={16} color={accent} />
      </View>
      <Text style={[styles.statValue, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
        {label}
      </Text>
    </View>
  );
}

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const dashboardQuery = useGetDashboard();
  const scanStatusQuery = useGetScanStatus();
  const startScanMutation = useStartScan();

  const dashboard = dashboardQuery.data;
  const scanStatus = scanStatusQuery.data;
  const isRefreshing = dashboardQuery.isFetching && !dashboardQuery.isLoading;

  const onRefresh = useCallback(() => {
    void dashboardQuery.refetch();
    void scanStatusQuery.refetch();
  }, [dashboardQuery, scanStatusQuery]);

  const onScanNow = useCallback(async () => {
    if (scanStatus?.isRunning) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startScanMutation.mutate(undefined, {
      onSuccess: () => {
        setTimeout(() => {
          void scanStatusQuery.refetch();
          void dashboardQuery.refetch();
        }, 1200);
      },
    });
  }, [scanStatus?.isRunning, startScanMutation, scanStatusQuery, dashboardQuery]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 + 84 : insets.bottom + 60;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: topPad + 16, paddingBottom: bottomPad }}
      scrollEnabled
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={[styles.logoMark, { backgroundColor: colors.primary + "22", borderColor: colors.primary + "44" }]}>
            <Feather name="server" size={18} color={colors.primary} />
          </View>
          <Text style={[styles.headerTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
            Willard AI
          </Text>
        </View>
        {scanStatus?.isRunning && (
          <View style={[styles.scanBadge, { backgroundColor: colors.primary + "22", borderColor: colors.primary + "44" }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.scanBadgeText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
              Scanning
            </Text>
          </View>
        )}
      </View>

      {/* Stats grid */}
      {dashboardQuery.isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : dashboardQuery.isError ? (
        <View style={[styles.errorCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="wifi-off" size={24} color={colors.mutedForeground} />
          <Text style={[styles.errorText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Could not reach server
          </Text>
          <Pressable
            onPress={() => void dashboardQuery.refetch()}
            style={[styles.retryButton, { borderColor: colors.border }]}
          >
            <Text style={[styles.retryText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.statsGrid}>
            <StatCard
              label="Files"
              value={formatCount(dashboard?.totalFiles ?? 0)}
              icon="file"
              accent={colors.primary}
            />
            <StatCard
              label="Total Size"
              value={formatBytes(dashboard?.totalSizeBytes ?? 0)}
              icon="hard-drive"
              accent="#0dd9a0"
            />
            <StatCard
              label="Archives"
              value={formatCount(dashboard?.archiveCount ?? 0)}
              icon="archive"
              accent="#f0a020"
            />
            <StatCard
              label="Documents"
              value={formatCount(dashboard?.documentCount ?? 0)}
              icon="file-text"
              accent="#b060ff"
            />
          </View>

          {/* Duplicates row */}
          {(dashboard?.duplicateCount ?? 0) > 0 && (
            <View style={[styles.alertCard, { backgroundColor: "#ef4343" + "11", borderColor: "#ef4343" + "44" }]}>
              <Feather name="copy" size={16} color="#ef4343" />
              <Text style={[styles.alertText, { color: "#ef4343", fontFamily: "Inter_500Medium" }]}>
                {formatCount(dashboard!.duplicateCount)} duplicate files detected
              </Text>
            </View>
          )}

          {/* Scan status card */}
          <View style={[styles.scanCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.scanCardTop}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                LAST SCAN
              </Text>
              <Text style={[styles.scanTime, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                {timeAgo(dashboard?.lastScanAt ?? null)}
              </Text>
            </View>

            {scanStatus?.isRunning && scanStatus.current && (
              <View style={styles.progressRow}>
                <View style={[styles.progressTrack, { backgroundColor: colors.muted }]}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        backgroundColor: colors.primary,
                        width: scanStatus.current.totalFiles
                          ? `${Math.min(100, (scanStatus.current.filesScanned / (scanStatus.current.totalFiles ?? 1)) * 100)}%`
                          : "30%",
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.progressText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                  {formatCount(scanStatus.current.filesScanned)} files
                </Text>
              </View>
            )}

            <Pressable
              onPress={onScanNow}
              disabled={scanStatus?.isRunning || startScanMutation.isPending}
              style={({ pressed }) => [
                styles.scanButton,
                {
                  backgroundColor: scanStatus?.isRunning ? colors.muted : colors.primary,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              {startScanMutation.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Feather
                    name={scanStatus?.isRunning ? "loader" : "refresh-cw"}
                    size={15}
                    color={scanStatus?.isRunning ? colors.mutedForeground : "#fff"}
                  />
                  <Text
                    style={[
                      styles.scanButtonText,
                      {
                        color: scanStatus?.isRunning ? colors.mutedForeground : "#fff",
                        fontFamily: "Inter_600SemiBold",
                      },
                    ]}
                  >
                    {scanStatus?.isRunning ? "Scan running…" : "Scan Now"}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logoMark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 22,
    letterSpacing: -0.4,
  },
  scanBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  scanBadgeText: {
    fontSize: 12,
  },
  loadingContainer: {
    paddingTop: 60,
    alignItems: "center",
  },
  errorCard: {
    margin: 20,
    padding: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    gap: 10,
  },
  errorText: {
    fontSize: 14,
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  retryText: {
    fontSize: 14,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 14,
  },
  statCard: {
    width: "47%",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 6,
  },
  statIconBg: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  statValue: {
    fontSize: 26,
    letterSpacing: -0.5,
  },
  statLabel: {
    fontSize: 12,
  },
  alertCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  alertText: {
    fontSize: 13,
  },
  scanCard: {
    marginHorizontal: 16,
    padding: 18,
    borderRadius: 12,
    borderWidth: 1,
    gap: 14,
  },
  scanCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
  },
  scanTime: {
    fontSize: 15,
  },
  progressRow: {
    gap: 6,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  progressText: {
    fontSize: 11,
    textAlign: "right",
  },
  scanButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
  },
  scanButtonText: {
    fontSize: 15,
  },
});
