import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/apiClient';
import type { SessionDetailResponse, SessionSummary } from '../types/api';

export const SESSIONS_QUERY_KEY = ['sessions'] as const;
export const sessionDetailQueryKey = (sessionId: string) => ['session', sessionId] as const;

/**
 * Hook to retrieve all conversation sessions.
 */
export function useSessions() {
  return useQuery<SessionSummary[], Error>({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => apiClient.getSessions(),
    staleTime: 5000,
    refetchInterval: 10000,
  });
}

/**
 * Hook to retrieve complete message history for a specific session.
 */
export function useSessionDetail(sessionId: string | null) {
  return useQuery<SessionDetailResponse, Error>({
    queryKey: sessionDetailQueryKey(sessionId || ''),
    queryFn: () => apiClient.getSession(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 30000,
  });
}

