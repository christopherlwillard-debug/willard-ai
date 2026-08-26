import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { getGetCollectionsQueryKey } from "@workspace/api-client-react";

import { API_BASE_URL } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

type Collection = { id: number; name: string; kind: "auto" | "smart" | "manual"; itemCount: number; coverFileId: number | null };
type CollectionsResponse = { collections: Collection[]; favoritesCount: number };

export default function CollectionsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const query = useQuery({
    queryKey: getGetCollectionsQueryKey(),
    queryFn: async () => {
      const response = await fetch(`${API_BASE_URL}/api/collections`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load collections");
      return response.json() as Promise<CollectionsResponse>;
    },
  });
  const collections = query.data?.collections ?? [];

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}><Feather name="arrow-left" size={22} color={colors.foreground} /></Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>Collections</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>Albums and favorites</Text>
        </View>
      </View>
      {query.isLoading ? <View style={styles.center}><ActivityIndicator color={colors.primary} /></View> : query.isError ? (
        <View style={styles.center}><Feather name="wifi-off" size={26} color={colors.mutedForeground} /><Text style={[styles.empty, { color: colors.mutedForeground }]}>Could not load collections</Text></View>
      ) : (
        <FlatList
          data={collections}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Pressable onPress={() => router.push("/collection/favorites")} style={[styles.favoriteCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.iconCircle, { backgroundColor: "#ef434322" }]}><Feather name="heart" size={21} color="#ef6c9b" /></View>
              <View style={styles.cardCopy}><Text style={[styles.cardTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>Favorites</Text><Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{query.data?.favoritesCount ?? 0} files</Text></View>
              <Feather name="chevron-right" size={19} color={colors.mutedForeground} />
            </Pressable>
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push({ pathname: "/collection/[id]", params: { id: String(item.id), name: item.name } })} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.iconCircle, { backgroundColor: colors.primary + "22" }]}><Feather name={item.kind === "smart" ? "filter" : "folder"} size={21} color={colors.primary} /></View>
              <View style={styles.cardCopy}><Text numberOfLines={1} style={[styles.cardTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>{item.name}</Text><Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{item.itemCount} files · {item.kind === "smart" ? "Smart folder" : item.kind === "auto" ? "Automatic album" : "Album"}</Text></View>
              <Feather name="chevron-right" size={19} color={colors.mutedForeground} />
            </Pressable>
          )}
          ListEmptyComponent={<View style={styles.center}><Feather name="folder" size={28} color={colors.mutedForeground} /><Text style={[styles.empty, { color: colors.mutedForeground }]}>No albums yet</Text></View>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 18 },
  headerCopy: { gap: 3 },
  title: { fontSize: 23 },
  subtitle: { fontSize: 12 },
  list: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { minHeight: 76, borderWidth: 1, borderRadius: 13, padding: 14, flexDirection: "row", alignItems: "center", gap: 13 },
  favoriteCard: { minHeight: 76, borderWidth: 1, borderRadius: 13, padding: 14, flexDirection: "row", alignItems: "center", gap: 13, marginBottom: 10 },
  iconCircle: { width: 43, height: 43, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  cardCopy: { flex: 1, gap: 5 },
  cardTitle: { fontSize: 16 },
  cardMeta: { fontSize: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  empty: { fontSize: 14 },
});