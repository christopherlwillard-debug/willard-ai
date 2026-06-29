import {
  useGetSettings,
  useUpdateSettings,
} from "@workspace/api-client-react";
import type { SettingsInput } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

type FieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences";
  icon: keyof typeof Feather.glyphMap;
};

function Field({ label, value, onChange, placeholder, secureTextEntry, autoCapitalize = "none", icon }: FieldProps) {
  const colors = useColors();
  return (
    <View style={styles.fieldWrapper}>
      <View style={styles.fieldLabel}>
        <Feather name={icon} size={13} color={colors.mutedForeground} />
        <Text style={[styles.labelText, { color: colors.mutedForeground, fontFamily: "Inter_500Medium" }]}>
          {label}
        </Text>
      </View>
      <TextInput
        style={[
          styles.textInput,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            color: colors.foreground,
            fontFamily: "Inter_400Regular",
          },
        ]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
      />
    </View>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const settingsQuery = useGetSettings();
  const updateMutation = useUpdateSettings();
  const [nasPath, setNasPath] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settingsQuery.data) {
      setNasPath(settingsQuery.data.nasPath ?? "");
    }
  }, [settingsQuery.data]);

  const onSave = useCallback(async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const input: SettingsInput = {
      nasPath,
    };
    updateMutation.mutate(input, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["/settings"] });
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      },
    });
  }, [nasPath, updateMutation, queryClient]);


  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 + 84 : insets.bottom + 60;

  const settings = settingsQuery.data;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: topPad + 16, paddingBottom: bottomPad }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>
          Settings
        </Text>
        {settings && (
          <View style={styles.statsRow}>
            <Text style={[styles.statChip, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
              {settings.totalFilesIndexed.toLocaleString()} files indexed
            </Text>
          </View>
        )}
      </View>

      {settingsQuery.isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <>
          {/* NAS Section */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: colors.primary + "22" }]}>
                <Feather name="hard-drive" size={14} color={colors.primary} />
              </View>
              <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                NAS Storage
              </Text>
            </View>
            <Field
              label="NAS PATH"
              value={nasPath}
              onChange={setNasPath}
              placeholder="/mnt/nas"
              icon="folder"
            />
          </View>

          {/* About Section */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: "#b060ff" + "22" }]}>
                <Feather name="info" size={14} color="#b060ff" />
              </View>
              <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: "Inter_600SemiBold" }]}>
                About
              </Text>
            </View>
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Last Scan
              </Text>
              <Text style={[styles.aboutValue, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                {settings?.lastScanAt
                  ? new Date(settings.lastScanAt).toLocaleString()
                  : "Never"}
              </Text>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutLabel, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
                Indexed Files
              </Text>
              <Text style={[styles.aboutValue, { color: colors.foreground, fontFamily: "Inter_500Medium" }]}>
                {settings?.totalFilesIndexed.toLocaleString() ?? "—"}
              </Text>
            </View>
          </View>

          {/* Save button */}
          <Pressable
            onPress={onSave}
            disabled={updateMutation.isPending}
            style={({ pressed }) => [
              styles.saveButton,
              {
                backgroundColor: saved ? "#0dd9a0" : colors.primary,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
            testID="save-settings-button"
          >
            {updateMutation.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather name={saved ? "check" : "save"} size={16} color="#fff" />
                <Text style={[styles.saveButtonText, { fontFamily: "Inter_600SemiBold" }]}>
                  {saved ? "Saved!" : "Save Settings"}
                </Text>
              </>
            )}
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
    paddingHorizontal: 20,
    marginBottom: 20,
    gap: 6,
  },
  headerTitle: {
    fontSize: 28,
    letterSpacing: -0.5,
  },
  statsRow: {
    flexDirection: "row",
  },
  statChip: {
    fontSize: 13,
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 2,
  },
  sectionIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: {
    fontSize: 15,
  },
  fieldWrapper: {
    gap: 6,
  },
  fieldLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  labelText: {
    fontSize: 11,
    letterSpacing: 0.6,
  },
  textInput: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  testResult: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  testResultText: {
    fontSize: 13,
    flex: 1,
  },
  testButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 9,
  },
  testButtonText: {
    fontSize: 13,
  },
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  aboutLabel: {
    fontSize: 13,
  },
  aboutValue: {
    fontSize: 13,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 4,
  },
  saveButtonText: {
    fontSize: 16,
    color: "#fff",
  },
});
