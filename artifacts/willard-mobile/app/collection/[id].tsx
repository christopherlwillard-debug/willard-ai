import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGetCollectionsIdItemsQueryKey,
  getGetCollectionsQueryKey,
  getGetMediaFilesQueryKey,
} from "@workspace/api-client-react";

import { API_BASE_URL } from "@/lib/api";
import { invalidateFavoriteCaches } from "@/lib/favorite-cache";
import { useColors } from "@/hooks/useColors";

type MediaFile = { id: number; name: string; filename?: string; mediaType?: string; fileType?: string; extension?: string; favorite?: boolean };
type ItemsResponse = { files: MediaFile[]; total: number };

async function getJson(path: string) {
  const response = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error("Request failed");
  return response.json();
}

export default function CollectionDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const isFavorites = params.id === "favorites";
  const collectionId = Number(params.id);
  const collectionQueryKey = isFavorites
    ? getGetMediaFilesQueryKey()
    : getGetCollectionsIdItemsQueryKey(collectionId);
  const query = useQuery({
    queryKey: collectionQueryKey,
    queryFn: () => isFavorites ? getJson("/api/media/files?favorites=true&limit=200") as Promise<ItemsResponse> : getJson(`/api/collections/${params.id}/items?limit=200`) as Promise<ItemsResponse>,
  });
  const favoriteMutation = useMutation({
    mutationFn: async ({ id, favorite }: { id: number; favorite: boolean }) => {
      const response = await fetch(`${API_BASE_URL}/api/media/files/${id}/favorite`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ favorite }) });
      if (!response.ok) throw new Error("Could not update favorite");
    },
    onSuccess: () => {
      void invalidateFavoriteCaches(queryClient, {
        activeCollection: collectionQueryKey,
        mediaFiles: getGetMediaFilesQueryKey(),
        collections: getGetCollectionsQueryKey(),
      });
    },
  });
  const files = query.data?.files ?? [];

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Feather name="arrow-left" size={22} color={colors.foreground} /></Pressable>
        <View style={styles.headerCopy}><Text numberOfLines={1} style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>{isFavorites ? "Favorites" : params.name ?? "Album"}</Text><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{query.data?.total ?? files.length} files</Text></View>
      </View>
      {query.isLoading ? <View style={styles.center}><ActivityIndicator color={colors.primary} /></View> : query.isError ? <View style={styles.center}><Text style={[styles.empty, { color: colors.mutedForeground }]}>Could not load files</Text></View> : (
        <FlatList
          data={files}
          numColumns={2}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          renderItem={({ item }) => (
            <View style={[styles.fileCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.fileIcon, { backgroundColor: colors.muted }]}><Feather name={item.mediaType === "video" ? "video" : "image"} size={25} color={colors.primary} /></View>
              <Text numberOfLines={2} style={[styles.fileName, { color: colors.foreground }]}>{item.name ?? item.filename ?? "File"}</Text>
              <Pressable onPress={() => favoriteMutation.mutate({ id: item.id, favorite: !item.favorite })} hitSlop={8} style={styles.heart}>
                <Feather name="heart" size={18} color={item.favorite ? colors.destructive : colors.mutedForeground} />
              </Pressable>
            </View>
          )}
          ListEmptyComponent={<View style={styles.center}><Feather name="image" size={28} color={colors.mutedForeground} /><Text style={[styles.empty, { color: colors.mutedForeground }]}>{isFavorites ? "No favorites yet" : "This album is empty"}</Text></View>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 18 },
  headerCopy: { flex: 1, gap: 3 },
  title: { fontSize: 22 },
  subtitle: { fontSize: 12 },
  grid: { padding: 16, gap: 10, paddingBottom: 40 },
  row: { gap: 10 },
  fileCard: { flex: 1, minHeight: 160, borderWidth: 1, borderRadius: 12, overflow: "hidden", position: "relative" },
  fileIcon: { height: 112, alignItems: "center", justifyContent: "center" },
  fileName: { fontSize: 13, lineHeight: 18, padding: 10, paddingRight: 34 },
  heart: { position: "absolute", right: 9, bottom: 9 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  empty: { fontSize: 14 },
});