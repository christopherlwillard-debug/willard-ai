import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetAuthStatus, getGetAuthStatusQueryKey } from "@workspace/api-client-react";
import { apiUrl } from "@/lib/api";
import { createUnauthorizedAwareFetch } from "@/lib/session-expiry";

interface AuthContextValue {
  authenticated: boolean;
  setup: boolean;
  loading: boolean;
  refetch: () => void;
  invalidate: () => Promise<void>;
  authError: Error | null;
}

const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  setup: false,
  loading: true,
  refetch: () => {},
  invalidate: async () => {},
  authError: null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [sessionExpired, setSessionExpired] = useState(false);
  const sessionExpiredRef = useRef(false);
  const setupRef = useRef(false);

  const { data, isLoading, isError, error, refetch } = useGetAuthStatus({
    query: {
      queryKey: getGetAuthStatusQueryKey(),
      retry: false,
      staleTime: 30_000,
    },
  });

  useEffect(() => {
    setupRef.current = data?.setup ?? false;
  }, [data?.setup]);

  const handleSessionExpired = useCallback(() => {
    if (sessionExpiredRef.current) return;

    sessionExpiredRef.current = true;
    queryClient.clear();
    queryClient.setQueryData(getGetAuthStatusQueryKey(), {
      authenticated: false,
      setup: setupRef.current,
    });
    setSessionExpired(true);
  }, [queryClient]);

  useEffect(() => {
    const apiBaseUrl = new URL(apiUrl("/"), window.location.origin).toString();
    const originalFetch = window.fetch.bind(window);
    const unauthorizedAwareFetch = createUnauthorizedAwareFetch(
      originalFetch,
      apiBaseUrl,
      handleSessionExpired,
    );

    window.fetch = unauthorizedAwareFetch;
    return () => {
      if (window.fetch === unauthorizedAwareFetch) {
        window.fetch = originalFetch;
      }
    };
  }, [handleSessionExpired]);

  const invalidate = useCallback(async () => {
    sessionExpiredRef.current = false;
    setSessionExpired(false);
    await queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
  }, [queryClient]);

  const value: AuthContextValue = {
    authenticated: !sessionExpired && (data?.authenticated ?? false),
    setup: data?.setup ?? false,
    loading: !sessionExpired && isLoading,
    refetch: () => void refetch(),
    invalidate,
    authError: sessionExpired ? null : (isError ? (error as Error) : null),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
