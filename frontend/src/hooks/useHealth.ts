import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/apiClient';
import type { HealthResponse } from '../types/api';
import { useUIStore } from '../stores/useUIStore';

export const HEALTH_QUERY_KEY = ['health'] as const;

export function useHealth() {
  const isAuthenticated = useUIStore((state) => state.isAuthenticated);

  return useQuery<HealthResponse, Error>({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: () => apiClient.getHealth(),
    enabled: isAuthenticated,
    // Poll every 15 seconds to reflect changes in Ollama or network connectivity
    refetchInterval: isAuthenticated ? 15000 : false,
    refetchIntervalInBackground: false,
    retry: 1,
    staleTime: 10000,
  });
}

