import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/apiClient';
import type { HealthResponse } from '../types/api';

export const HEALTH_QUERY_KEY = ['health'] as const;

export function useHealth() {
  return useQuery<HealthResponse, Error>({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: () => apiClient.getHealth(),
    // Poll every 15 seconds to reflect changes in Ollama or network connectivity
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: 1,
    staleTime: 10000,
  });
}

