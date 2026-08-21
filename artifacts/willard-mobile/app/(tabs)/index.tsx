import {
  useGetDashboard,
  useGetScanStatus,
  useGetStorageStats,
  useGetTopFolders,
  useStartScan,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
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

function formatTypeLabel(fileType: string): string {
  if (fileType === "image") return "Images";
  if (fileType === "video") return "Videos";
  if (fileType === "document") return "Documents";
  if (fileType === "audio") return "Audio";
  if (fileType === "archive") return "Archives";
  return fileType.charAt(0).toUpperCase() + fileType.slice(1);
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

const breakdownColors = ["#0080ff", "#0dd9a0", "#b060ff", "#f0a020", "#ef6c9b", "#7785ff"];

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const dashboardQuery = useGetDashboard();
  const scanStatusQuery = useGetScanStatus();
  const storageQuery = useGetStorageStats();
  const topFoldersQuery = useGetTopFolders();
  const startScanMutation = useStartScan();

  const dashboard = dashboardQuery.data;
  const scanStatus = scanStatusQuery.data;
  const isRefreshing = dashboardQuery.isFetching && !dashboardQuery.isLoading;

  const onRefresh = useCallback(() => {
    void dashboardQuery.refetch();
    void scanStatusQuery.refetch();
    void storageQuery.refetch();
    void topFoldersQuery.refetch();
  }, [dashboardQuery, scanStatusQuery, storageQuery, topFoldersQuery]);

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

           <View style={styles.breakdownSection}>
             <View style={styles.sectionHeading}>
               <View>
                 <Text style={[styles.breakdownTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                   Storage breakdown
                 </Text>
                 <Text style={[styles.breakdownSubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                   See what is using space on your NAS
                 </Text>
               </View>
               {storageQuery.isFetching && <ActivityIndicator size="small" color={colors.primary} />}
             </View>

             <View style={[styles.chartCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
               <Text style={[styles.chartLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                 BY FILE TYPE
               </Text>
               {storageQuery.isLoading ? (
                 <View style={styles.chartLoading}>
                   <ActivityIndicator color={colors.primary} />
                 </View>
               ) : (storageQuery.data?.typeBreakdown.length ?? 0) === 0 ? (
                 <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                   No file type data yet
                 </Text>
               ) : (
                 <View style={styles.typeList}>
                   {storageQuery.data!.typeBreakdown
                     .slice()
                     .sort((a, b) => b.sizeBytes - a.sizeBytes)
                     .map((type, index) => (
                       <View key={type.fileType} style={styles.typeRow}>
                         <View style={styles.typeRowTop}>
                           <View style={styles.typeName}>
                             <View style={[styles.legendDot, { backgroundColor: breakdownColors[index % breakdownColors.length] }]} />
                             <Text style={[styles.typeText, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                               {formatTypeLabel(type.fileType)}
                             </Text>
                           </View>
                           <Text style={[styles.typeValue, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                             {formatBytes(type.sizeBytes)} · {type.percentage.toFixed(1)}%
                           </Text>
                         </View>
                         <View style={[styles.barTrack, { backgroundColor: colors.muted }]}>
                           <View
                             style={[
                               styles.barFill,
                               {
                                 backgroundColor: breakdownColors[index % breakdownColors.length],
                                 width: `${Math.max(type.percentage, type.sizeBytes > 0 ? 1 : 0)}%`,
                               },
                             ]}
                           />
                         </View>
                       </View>
                     ))}
                 </View>
               )}
             </View>

             <View style={[styles.chartCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
               <View style={styles.folderHeading}>
                 <Text style={[styles.chartLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
                   LARGEST FOLDERS
                 </Text>
                 <Text style={[styles.folderCount, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                   Top 10
                 </Text>
               </View>
               {topFoldersQuery.isLoading ? (
                 <View style={styles.chartLoading}>
                   <ActivityIndicator color={colors.primary} />
                 </View>
               ) : (topFoldersQuery.data?.length ?? 0) === 0 ? (
                 <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                   No folder data yet
                 </Text>
               ) : (
                 <View style={styles.folderList}>
                   {topFoldersQuery.data!.slice(0, 10).map((folder, index, folders) => {
                     const maxSize = folders[0]?.totalSizeBytes || 1;
                     return (
                       <View key={folder.folder} style={styles.folderRow}>
                         <View style={styles.folderRowTop}>
                           <Text
                             numberOfLines={1}
                             style={[styles.folderName, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}
                           >
                             {folder.folder}
                           </Text>
                           <Text style={[styles.folderSize, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                             {formatBytes(folder.totalSizeBytes)}
                           </Text>
                         </View>
                         <View style={[styles.barTrack, { backgroundColor: colors.muted }]}>
                           <View
                             style={[
                               styles.barFill,
                               {
                                 backgroundColor: index === 0 ? colors.primary : colors.primary + "bb",
                                 width: `${Math.max((folder.totalSizeBytes / maxSize) * 100, 1)}%`,
                               },
                             ]}
                           />
                         </View>
                       </View>
                     );
                   })}
                 </View>
               )}
             </View>
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
          <Pressable
            onPress={() => router.push("/(tabs)/library")}
            style={({ pressed }) => [
              styles.libraryButton,
              { backgroundColor: colors.secondary, borderColor: colors.border, opacity: pressed ? 0.75 : 1 },
            ]}
          >
            <Feather name="folder" size={17} color={colors.primary} />
            <View style={styles.libraryButtonCopy}>
              <Text style={[styles.libraryButtonTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                Browse your library
              </Text>
              <Text style={[styles.libraryButtonSubtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Explore folders or search indexed files
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
          </Pressable>
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
  breakdownSection: {
    gap: 12,
    marginBottom: 14,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginTop: 4,
  },
  breakdownTitle: {
    fontSize: 18,
    letterSpacing: -0.2,
  },
  breakdownSubtitle: {
    fontSize: 12,
    marginTop: 3,
  },
  chartCard: {
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 14,
  },
  chartLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
  },
  chartLoading: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 13,
  },
  typeList: {
    gap: 13,
  },
  typeRow: {
    gap: 7,
  },
  typeRowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  typeName: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  typeText: {
    fontSize: 13,
  },
  typeValue: {
    fontSize: 11,
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
  folderHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  folderCount: {
    fontSize: 11,
  },
  folderList: {
    gap: 14,
  },
  folderRow: {
    gap: 7,
  },
  folderRowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  folderName: {
    flex: 1,
    fontSize: 13,
  },
  folderSize: {
    fontSize: 11,
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
  libraryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 14,
    padding: 15,
    borderRadius: 12,
    borderWidth: 1,
  },
  libraryButtonCopy: {
    flex: 1,
    gap: 3,
  },
  libraryButtonTitle: {
    fontSize: 15,
  },
  libraryButtonSubtitle: {
    fontSize: 12,
  },
});
