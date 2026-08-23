import AsyncStorage from "@react-native-async-storage/async-storage";
import { setCookieGetter } from "@workspace/api-client-react";
import { fetch } from "expo/fetch";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import { API_BASE_URL } from "@/lib/api";

const COOKIE_STORAGE_KEY = "willard.sessionCookie";

type AuthContextValue = {
  authenticated: boolean;
  loading: boolean;
  cookie: string | null;
  error: string | null;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
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

  useEffect(() => {
    setCookieGetter(() => Platform.OS === "web" ? null : sessionCookie);
    let active = true;
    (async () => {
      const stored = await AsyncStorage.getItem(COOKIE_STORAGE_KEY);
      if (stored) {
        sessionCookie = stored;
        if (active) setCookie(stored);
      }
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/status`, {
          credentials: "include",
          headers: stored ? { Cookie: stored } : undefined,
        });
        const status = await response.json() as { authenticated?: boolean };
        if (active) setAuthenticated(status.authenticated === true);
      } catch {
        if (active) setAuthenticated(false);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      setCookieGetter(null);
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    authenticated,
    loading,
    cookie,
    error,
    login: async (password) => {
      setError(null);
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
        if (nextCookie) {
          sessionCookie = nextCookie;
          setCookie(nextCookie);
          await AsyncStorage.setItem(COOKIE_STORAGE_KEY, nextCookie);
        }
        setAuthenticated(true);
        return true;
      } catch {
        setError("Unable to reach Willard AI. Check the server connection.");
        return false;
      }
    },
    logout: async () => {
      try {
        await fetch(`${API_BASE_URL}/api/auth/logout`, {
          method: "POST",
          credentials: "include",
          headers: sessionCookie ? { Cookie: sessionCookie } : undefined,
        });
      } finally {
        sessionCookie = null;
        setCookie(null);
        setAuthenticated(false);
        await AsyncStorage.removeItem(COOKIE_STORAGE_KEY);
      }
    },
  }), [authenticated, loading, cookie, error]);

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