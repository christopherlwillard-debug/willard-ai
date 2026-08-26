import {
  getListFolderQueryKey,
  getSearchFilesQueryKey,
  getStreamMediaFileUrl,
  useListFolder,
  useSearchFiles,
} from "@workspace/api-client-react";
import type { FolderEntry, IndexedFile } from "@workspace/api-client-react";
import { Feather } from "@expo/vector-icons";
import { VideoView, useVideoPlayer } from "expo-video";
import { Image } from "expo-image";
import { WebView } from "react-native-webview";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { getSessionCookie } from "@/context/AuthContext";

const TYPE_FILTERS = [
  { label: "All types", value: "" },
  { label: "Images", value: "image" },
  { label: "Videos", value: "video" },
  { label: "Documents", value: "document" },
  { label: "Archives", value: "archive" },
];
const SIZE_FILTERS = [
  { label: "Any size", minSize: undefined, maxSize: undefined },
  { label: "Under 10 MB", minSize: undefined, maxSize: 10_000_000 },
  { label: "10–100 MB", minSize: 10_000_000, maxSize: 100_000_000 },
  { label: "Over 100 MB", minSize: 100_000_000, maxSize: undefined },
];

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function FileIcon({ entry, color }: { entry: FolderEntry | IndexedFile; color: string }) {
  const isDirectory = "isDirectory" in entry && entry.isDirectory;
  const icon = isDirectory ? "folder" : "file";
  return <Feather name={icon} size={21} color={isDirectory ? "#f0a020" : color} />;
}

export default function LibraryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [path, setPath] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [fileType, setFileType] = useState("");
  const [sizeIndex, setSizeIndex] = useState(0);
  const [selectedFile, setSelectedFile] = useState<IndexedFile | FolderEntry | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [returnToSearch, setReturnToSearch] = useState(false);
  const sizeFilter = SIZE_FILTERS[sizeIndex];
  const isSearching = searchQuery.trim().length > 0;
  const folderParams = { path };
  const searchParams = {
    q: searchQuery.trim(),
    fileType: fileType || undefined,
    minSize: sizeFilter.minSize,
    maxSize: sizeFilter.maxSize,
    limit: 100,
  };

  const folderQuery = useListFolder(folderParams, {
    query: { enabled: !isSearching, queryKey: getListFolderQueryKey(folderParams) },
  });
  const searchFilesQuery = useSearchFiles(
    searchParams,
    { query: { enabled: isSearching, queryKey: getSearchFilesQueryKey(searchParams) } },
  );

  const crumbs = useMemo(() => path ? ["Library", ...path.split(/[\\/]/).filter(Boolean)] : ["Library"], [path]);
  const folderEntries = folderQuery.data?.entries ?? [];
  const searchEntries = searchFilesQuery.data?.files ?? [];
  const entries: Array<FolderEntry | IndexedFile> = isSearching ? searchEntries : folderEntries;
  const loading = isSearching ? searchFilesQuery.isLoading : folderQuery.isLoading;
  const error = isSearching ? searchFilesQuery.isError : folderQuery.isError;

  const submitSearch = () => setSearchQuery(searchText);
  const clearSearch = () => {
    setSearchText("");
    setSearchQuery("");
    setFileType("");
    setSizeIndex(0);
  };
  const goUp = () => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    setPath(parts.slice(0, -1).join("/"));
  };
  const openFolder = (entry: FolderEntry) => setPath(entry.path);
  const openContainingFolder = (file: IndexedFile) => {
    const folder = (file.folder || "").replace(/[\\/]+$/, "");
    setPath(folder);
    setSearchQuery("");
    setReturnToSearch(true);
  };
  const resumeSearch = () => {
    setSearchQuery(searchText);
    setReturnToSearch(false);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: Platform.OS === "web" ? 67 : insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backButton}>
          <Feather name="arrow-left" size={21} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>Library</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
            Browse and search your NAS
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/collections")}
          style={[styles.collectionsButton, { borderColor: colors.border, backgroundColor: colors.card }]}
          hitSlop={6}
        >
          <Feather name="heart" size={16} color={colors.primary} />
          <Text style={[styles.collectionsButtonText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>Albums</Text>
        </Pressable>
      </View>

      <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="search" size={18} color={colors.mutedForeground} />
        <TextInput
          value={searchText}
          onChangeText={setSearchText}
          onSubmitEditing={submitSearch}
          placeholder="Search files by name…"
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="search"
          style={[styles.searchInput, { color: colors.foreground, fontFamily: "Inter_400Regular" }]}
        />
        {searchText.length > 0 && (
          <Pressable onPress={clearSearch} hitSlop={8}>
            <Feather name="x-circle" size={17} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>

      {isSearching && (
        <View style={styles.filterSection}>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={TYPE_FILTERS}
            keyExtractor={(item) => item.value || "all"}
            contentContainerStyle={styles.filterRow}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => setFileType(item.value)}
                style={[styles.chip, { borderColor: fileType === item.value ? colors.primary : colors.border, backgroundColor: fileType === item.value ? colors.primary + "22" : colors.card }]}
              >
                <Text style={[styles.chipText, { color: fileType === item.value ? colors.primary : colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>{item.label}</Text>
              </Pressable>
            )}
          />
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={SIZE_FILTERS}
            keyExtractor={(item) => item.label}
            contentContainerStyle={styles.filterRow}
            renderItem={({ item, index }) => (
              <Pressable
                onPress={() => setSizeIndex(index)}
                style={[styles.chip, { borderColor: sizeIndex === index ? colors.primary : colors.border, backgroundColor: sizeIndex === index ? colors.primary + "22" : colors.card }]}
              >
                <Text style={[styles.chipText, { color: sizeIndex === index ? colors.primary : colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>{item.label}</Text>
              </Pressable>
            )}
          />
        </View>
      )}

       {!isSearching && (
        <View style={styles.breadcrumbRow}>
          {!!path && <Pressable onPress={goUp} hitSlop={8}><Feather name="chevron-left" size={18} color={colors.primary} /></Pressable>}
          <Text numberOfLines={1} style={[styles.breadcrumb, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
            {crumbs.join("  /  ")}
          </Text>
           {returnToSearch && (
             <Pressable onPress={resumeSearch} style={[styles.searchReturnButton, { borderColor: colors.border, backgroundColor: colors.card }]}>
               <Feather name="search" size={13} color={colors.primary} />
               <Text style={[styles.searchReturnText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>Back to search</Text>
             </Pressable>
           )}
        </View>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={25} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>Could not load library</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Check that the NAS is online, then try again.</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.path}
          contentContainerStyle={[styles.list, entries.length === 0 && styles.emptyList]}
          renderItem={({ item }) => {
            const isFolder = "isDirectory" in item && item.isDirectory;
            return (
              <Pressable
                onPress={() => {
                  setPreviewError(null);
                  isFolder ? openFolder(item as FolderEntry) : setSelectedFile(item as IndexedFile | FolderEntry);
                }}
                style={({ pressed }) => [styles.entry, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.72 : 1 }]}
              >
                <FileIcon entry={item as FolderEntry | IndexedFile} color={colors.primary} />
                <View style={styles.entryCopy}>
                  <Text numberOfLines={1} style={[styles.entryName, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                    {"filename" in item ? item.filename : item.name}
                  </Text>
                  <Text numberOfLines={1} style={[styles.entryMeta, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                    {isFolder ? `${(item as FolderEntry).fileCount ?? 0} files` : `${formatBytes((item as IndexedFile).sizeBytes)} · ${(item as IndexedFile).fileType || (item as IndexedFile).extension || "File"}`}
                  </Text>
                </View>
                {!isFolder && isSearching && (
                  <Pressable
                    accessibilityLabel={`Open containing folder for ${(item as IndexedFile).filename}`}
                    onPress={(event) => {
                      event.stopPropagation();
                      openContainingFolder(item as IndexedFile);
                    }}
                    hitSlop={8}
                    style={styles.folderAction}
                  >
                    <Feather name="folder" size={17} color={colors.primary} />
                  </Pressable>
                )}
                <Feather name={isFolder ? "chevron-right" : "info"} size={17} color={colors.mutedForeground} />
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name={isSearching ? "search" : "folder"} size={28} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{isSearching ? "No matching files" : "This folder is empty"}</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>{isSearching ? "Try another name or adjust the filters." : "Files will appear here after a library scan."}</Text>
            </View>
          }
        />
      )}

      <Modal visible={selectedFile !== null} transparent animationType="slide" onRequestClose={() => setSelectedFile(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSelectedFile(null)}>
          <Pressable onPress={(event) => event.stopPropagation()} style={[styles.detailsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.detailsHandle} />
            <View style={styles.detailsTitleRow}>
              <Feather name="file" size={20} color={colors.primary} />
              <Text numberOfLines={2} style={[styles.detailsTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
                {selectedFile && ("filename" in selectedFile ? selectedFile.filename : selectedFile.name)}
              </Text>
              <Pressable onPress={() => setSelectedFile(null)} hitSlop={8}><Feather name="x" size={20} color={colors.mutedForeground} /></Pressable>
            </View>
            {selectedFile && (
              <View style={styles.previewArea}>
                {"id" in selectedFile && isPreviewable(selectedFile) ? (
                  <FilePreview file={selectedFile} onError={setPreviewError} />
                ) : (
                  <View style={[styles.unsupportedPreview, { borderColor: colors.border, backgroundColor: colors.background }]}>
                    <Feather name="file-text" size={28} color={colors.mutedForeground} />
                    <Text style={[styles.previewHint, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                      Preview is not available for this format. File details are still available below.
                    </Text>
                  </View>
                )}
                {previewError && (
                  <Text style={[styles.previewError, { color: colors.destructive, fontFamily: "Inter_400Regular" }]}>
                    {previewError} File details are still available below.
                  </Text>
                )}
              <View style={styles.detailRows}>
                <DetailRow label="Size" value={formatBytes("sizeBytes" in selectedFile ? selectedFile.sizeBytes : null)} colors={colors} />
                <DetailRow label="Type" value={"fileType" in selectedFile ? selectedFile.fileType || selectedFile.extension : "File"} colors={colors} />
                <DetailRow label="Path" value={selectedFile.path} colors={colors} />
              </View>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function isPreviewable(file: IndexedFile): boolean {
  return ["image", "video", "document"].includes((file.fileType || "").toLowerCase());
}

function FilePreview({ file, onError }: { file: IndexedFile; onError: (message: string) => void }) {
  const colors = useColors();
  const source = {
    uri: getStreamMediaFileUrl(file.id),
    headers: getSessionCookie() ? { Cookie: getSessionCookie() as string } : undefined,
  };
  const kind = (file.fileType || "").toLowerCase();
  const player = useVideoPlayer(kind === "video" ? source : null);

  if (kind === "image") {
    return (
      <Image
        source={source}
        contentFit="contain"
        style={styles.imagePreview}
        onError={() => onError("This image could not be loaded.")}
      />
    );
  }
  if (kind === "video") {
    return (
      <VideoView
        player={player}
        style={styles.videoPreview}
        nativeControls
        onFirstFrameRender={() => undefined}
      />
    );
  }
  return (
    <View style={styles.documentPreview}>
      <WebView
        source={source}
        style={styles.webView}
        originWhitelist={["*"]}
        onError={() => onError("This document could not be previewed on this device.")}
        startInLoadingState
        renderError={() => (
          <View style={styles.documentError}>
            <Feather name="file-text" size={28} color={colors.mutedForeground} />
            <Text style={[styles.previewHint, { color: colors.mutedForeground }]}>Document preview unavailable</Text>
          </View>
        )}
      />
    </View>
  );
}

function DetailRow({ label, value, colors }: { label: string; value: string; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>{label}</Text>
      <Text selectable style={[styles.detailValue, { color: colors.foreground, fontFamily: "Inter_400Regular" }]}>{value || "—"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 20, paddingTop: 15, paddingBottom: 18 },
  backButton: { width: 30, alignItems: "flex-start" },
  headerCopy: { gap: 3 },
  collectionsButton: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 18, paddingHorizontal: 11, paddingVertical: 8 },
  collectionsButtonText: { fontSize: 12 },
  title: { fontSize: 23, letterSpacing: -0.4 },
  subtitle: { fontSize: 12 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, paddingHorizontal: 13, height: 48, borderWidth: 1, borderRadius: 11 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  filterSection: { gap: 7, marginTop: 12 },
  filterRow: { gap: 7, paddingHorizontal: 16 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 12 },
  breadcrumbRow: { flexDirection: "row", alignItems: "center", gap: 3, marginHorizontal: 20, marginTop: 18, marginBottom: 8 },
  breadcrumb: { flex: 1, fontSize: 12 },
  searchReturnButton: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 9, paddingVertical: 6 },
  searchReturnText: { fontSize: 11 },
  folderAction: { padding: 5 },
  list: { padding: 16, gap: 8, paddingBottom: 110 },
  entry: { minHeight: 67, flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 14, borderWidth: 1, borderRadius: 11 },
  entryCopy: { flex: 1, gap: 5 },
  entryName: { fontSize: 15 },
  entryMeta: { fontSize: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 35, gap: 9 },
  emptyList: { flex: 1 },
  emptyTitle: { fontSize: 15, marginTop: 4 },
  emptyText: { fontSize: 13, textAlign: "center", lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#00000099" },
  detailsCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 20, paddingBottom: 35, gap: 20 },
  detailsHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: "#555866" },
  detailsTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  detailsTitle: { flex: 1, fontSize: 17, lineHeight: 23 },
  detailRows: { gap: 14 },
  previewArea: { gap: 10 },
  imagePreview: { width: "100%", height: 220, borderRadius: 12, backgroundColor: "#111318" },
  videoPreview: { width: "100%", height: 220, borderRadius: 12, backgroundColor: "#111318" },
  documentPreview: { width: "100%", height: 220, overflow: "hidden", borderRadius: 12, backgroundColor: "#f4f5f7" },
  webView: { flex: 1, backgroundColor: "transparent" },
  unsupportedPreview: { minHeight: 110, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center", padding: 18, gap: 9 },
  documentError: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  previewHint: { textAlign: "center", fontSize: 13, lineHeight: 19 },
  previewError: { fontSize: 12, lineHeight: 17 },
  detailRow: { gap: 4 },
  detailLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 },
  detailValue: { fontSize: 14, lineHeight: 19 },
});