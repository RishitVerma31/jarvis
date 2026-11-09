import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/apiClient';
import type { SessionDetailResponse, SessionSummary } from '../types/api';
import { useUIStore } from '../stores/useUIStore';

export const SESSIONS_QUERY_KEY = ['sessions'] as const;
export const sessionDetailQueryKey = (sessionId: string) => ['session', sessionId] as const;

/**
 * Hook to retrieve all conversation sessions.
 */
export function useSessions() {
  const isAuthenticated = useUIStore((state) => state.isAuthenticated);

  return useQuery<SessionSummary[], Error>({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => apiClient.getSessions(),
    enabled: isAuthenticated,
    staleTime: 5000,
    refetchInterval: isAuthenticated ? 10000 : false,
  });
}

/**
 * Hook to retrieve complete message history for a specific session.
 */
export function useSessionDetail(sessionId: string | null) {
  const isAuthenticated = useUIStore((state) => state.isAuthenticated);

  return useQuery<SessionDetailResponse, Error>({
    queryKey: sessionDetailQueryKey(sessionId || ''),
    queryFn: () => apiClient.getSession(sessionId!),
    enabled: Boolean(sessionId) && isAuthenticated,
    staleTime: 30000,
  });
}

