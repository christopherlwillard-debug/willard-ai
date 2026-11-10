import AsyncStorage from "@react-native-async-storage/async-storage";
import { setCookieGetter, setUnauthorizedHandler } from "@workspace/api-client-react";
import { fetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";

import { API_BASE_URL } from "@/lib/api";
import { clearStoredSession, migrateSessionCookie } from "./auth-session-storage";
import { fetchMobileAuthStatus } from "./auth-status";

const COOKIE_STORAGE_KEY = "willard.sessionCookie";

type AuthContextValue = {
  authenticated: boolean;
  loading: boolean;
  cookie: string | null;
  error: string | null;
  setupRequired: boolean;
  statusError: string | null;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshStatus: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
let sessionCookie: string | null = null;

function cookieFromResponse(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(",")[0]?.split(";")[0]?.trim() || null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cookie, setCookie] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const mounted = useRef(true);

  const applyAuthStatus = useCallback((result: Awaited<ReturnType<typeof fetchMobileAuthStatus>>) => {
    if (!mounted.current) return;
    setStatusError(result.kind === "error" ? result.message : null);
    setSetupRequired(result.kind === "setup_required");
    setAuthenticated(result.kind === "authenticated");
  }, []);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setStatusError(null);
    try {
      const result = await fetchMobileAuthStatus(
        fetch,
        `${API_BASE_URL}/api/auth/status`,
        Platform.OS === "web" ? null : sessionCookie,
      );
      applyAuthStatus(result);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [applyAuthStatus]);

  const handleUnauthorized = useCallback(() => {
    if (!mounted.current) return;
    sessionCookie = null;
    setCookie(null);
    setAuthenticated(false);
    setSetupRequired(false);
    setStatusError(null);
    setError("Your session expired or was revoked. Sign in again.");
    if (Platform.OS !== "web") {
      void clearStoredSession(
        {
          getItemAsync: SecureStore.getItemAsync,
          setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
          deleteItemAsync: SecureStore.deleteItemAsync,
        },
        AsyncStorage,
        COOKIE_STORAGE_KEY,
      ).catch(() => {
        if (mounted.current) {
          setError("Your session expired. Sign in again; the saved session could not be fully removed from this device.");
        }
      });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setCookieGetter(() => Platform.OS === "web" ? null : sessionCookie);
    setUnauthorizedHandler(handleUnauthorized);
    void (async () => {
      try {
        if (Platform.OS !== "web") {
          const migration = await migrateSessionCookie(
            {
              getItemAsync: SecureStore.getItemAsync,
              setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
              }),
              deleteItemAsync: SecureStore.deleteItemAsync,
            },
            AsyncStorage,
            COOKIE_STORAGE_KEY,
          );
          sessionCookie = migration.cookie;
          setCookie(migration.cookie);
          if (!migration.legacyRemoved) {
            setError("Your session was secured, but an older stored copy could not be removed. Sign out and try again.");
          }
        }
      } catch {
        sessionCookie = null;
        setCookie(null);
        setError("Saved session storage could not be read securely. Sign in again; Willard will not use the older stored copy.");
      }

      try {
        const result = await fetchMobileAuthStatus(
          fetch,
          `${API_BASE_URL}/api/auth/status`,
          Platform.OS === "web" ? null : sessionCookie,
        );
        applyAuthStatus(result);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })().catch(() => {
      applyAuthStatus({ kind: "error", message: "Willard could not verify your session. Check the connection and retry." });
      if (mounted.current) setLoading(false);
    });

    return () => {
      mounted.current = false;
      setCookieGetter(null);
      setUnauthorizedHandler(null);
    };
  }, [applyAuthStatus, handleUnauthorized]);

  const value = useMemo<AuthContextValue>(() => ({
    authenticated,
    loading,
    cookie,
    error,
    setupRequired,
    statusError,
    refreshStatus,
    login: async (password) => {
      setError(null);
      if (setupRequired || statusError) return false;
      let sessionSavedSecurely = false;
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? "Login failed.");
          return false;
        }
        const nextCookie = cookieFromResponse(response);
        if (Platform.OS !== "web") {
          if (!nextCookie) {
            setError("Willard did not issue a mobile session cookie. Sign-in was not saved.");
            return false;
          }
          await SecureStore.setItemAsync(COOKIE_STORAGE_KEY, nextCookie, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          });
          const verifiedCookie = await SecureStore.getItemAsync(COOKIE_STORAGE_KEY);
          if (verifiedCookie !== nextCookie) {
            throw new Error("Secure session storage did not retain the new session.");
          }
          sessionSavedSecurely = true;
          sessionCookie = nextCookie;
          setCookie(nextCookie);
          try {
            await AsyncStorage.removeItem(COOKIE_STORAGE_KEY);
          } catch {
            setError("Sign-in succeeded, but an older insecure session copy could not be removed. Sign out and retry.");
          }
        }
        setAuthenticated(true);
        return true;
      } catch (loginError) {
        setError(sessionSavedSecurely
          ? "Sign-in succeeded, but Willard could not finish securing this device's saved session. Sign out and retry."
          : "Unable to reach Willard AI or save the session securely. Check the connection and device security settings.");
        return false;
      }
    },
    logout: async () => {
      let logoutError: string | null = null;
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
          method: "POST",
          credentials: "include",
          headers: Platform.OS !== "web" && sessionCookie ? { Cookie: sessionCookie } : undefined,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          logoutError = typeof body.error === "string"
            ? body.error
            : "The server did not confirm sign-out. The local session will still be cleared.";
        }
      } catch {
        logoutError = "The server could not confirm sign-out. The local session will still be cleared.";
      } finally {
        sessionCookie = null;
        setCookie(null);
        setAuthenticated(false);
        setSetupRequired(false);
        try {
          if (Platform.OS !== "web") {
            await clearStoredSession(
              {
                getItemAsync: SecureStore.getItemAsync,
                setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
                deleteItemAsync: SecureStore.deleteItemAsync,
              },
              AsyncStorage,
              COOKIE_STORAGE_KEY,
            );
          }
        } catch {
          logoutError = [logoutError, "The saved session could not be fully removed from this device."]
            .filter(Boolean)
            .join(" ");
        }
        setError(logoutError);
      }
    },
  }), [authenticated, loading, cookie, error, setupRequired, statusError, refreshStatus]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export function getSessionCookie(): string | null {
  return sessionCookie;
}