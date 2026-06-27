import { createContext, useContext, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetAuthStatus, getGetAuthStatusQueryKey } from "@workspace/api-client-react";

interface AuthContextValue {
  authenticated: boolean;
  setup: boolean;
  loading: boolean;
  refetch: () => void;
  invalidate: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  setup: false,
  loading: true,
  refetch: () => {},
  invalidate: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useGetAuthStatus({
    query: {
      queryKey: getGetAuthStatusQueryKey(),
      retry: false,
      staleTime: 30_000,
    },
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
  }, [queryClient]);

  const value: AuthContextValue = {
    authenticated: data?.authenticated ?? false,
    setup: data?.setup ?? false,
    loading: isLoading,
    refetch: () => void refetch(),
    invalidate,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
