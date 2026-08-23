import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

export function LoginScreen() {
  const colors = useColors();
  const { login, error } = useAuth();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    await login(password);
    setSubmitting(false);
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.icon, { backgroundColor: colors.primary + "22" }]}>
          <Feather name="shield" size={24} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: "Inter_700Bold" }]}>Willard AI</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground, fontFamily: "Inter_400Regular" }]}>
          Sign in to access your library
        </Text>
        <TextInput
          style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background, fontFamily: "Inter_400Regular" }]}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void submit()}
          returnKeyType="go"
          testID="mobile-login-password"
        />
        {error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}
        <Pressable
          onPress={() => void submit()}
          disabled={submitting || !password}
          style={({ pressed }) => [styles.button, { backgroundColor: colors.primary, opacity: pressed || !password ? 0.65 : 1 }]}
          testID="mobile-login-button"
        >
          {submitting ? <ActivityIndicator color="#fff" /> : <Text style={[styles.buttonText, { fontFamily: "Inter_600SemiBold" }]}>Sign in</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "center", padding: 20 },
  card: { width: "100%", maxWidth: 420, alignSelf: "center", borderWidth: 1, borderRadius: 16, padding: 24 },
  icon: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", marginBottom: 18 },
  title: { fontSize: 28, letterSpacing: -0.5 },
  subtitle: { fontSize: 15, marginTop: 6, marginBottom: 24 },
  input: { height: 50, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, fontSize: 16 },
  error: { fontSize: 13, marginTop: 10 },
  button: { height: 50, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: 18 },
  buttonText: { color: "#fff", fontSize: 15 },
});