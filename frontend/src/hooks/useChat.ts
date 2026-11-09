import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useMemo } from 'react';
import { apiClient, ApiError } from '../services/apiClient';
import { useUIStore } from '../stores/useUIStore';
import { useSessionDetail, sessionDetailQueryKey } from './useSessions';
import type { ChatResponse, SessionDetailResponse } from '../types/api';

export interface ChatMessage {
  id: string | number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  isPending?: boolean;
  isError?: boolean;
}

export function useChat() {
  const queryClient = useQueryClient();
  const { activeSessionId, setActiveSessionId } = useUIStore();

  // Load persistent history for currently selected session from SQLite
  const { data: sessionDetail, isLoading: isLoadingSession } = useSessionDetail(activeSessionId);

  // Local pending/optimistic messages during active mutation
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([]);

  // Generate a unique session ID on the frontend for new conversations
  const generateNewSessionId = useCallback(() => {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, []);

  // Mutation for sending chat message to existing POST /chat
  const chatMutation = useMutation<
    ChatResponse,
    ApiError,
    { sessionId: string; messageText: string; tempUserMsg: ChatMessage; tempBotMsg: ChatMessage }
  >({
    mutationFn: async ({ sessionId, messageText }) => {
      return apiClient.sendChatMessage({
        session_id: sessionId,
        message: messageText,
      });
    },
    onSuccess: (data, variables) => {
      const { sessionId, tempUserMsg } = variables;

      // Update the TanStack Query cache for this session
      queryClient.setQueryData<SessionDetailResponse>(
        sessionDetailQueryKey(sessionId),
        (old) => {
          const assistantMsg = {
            id: Date.now(),
            role: 'assistant' as const,
            content: data.reply,
            created_at: data.created_at || new Date().toISOString(),
          };

          if (!old) {
            return {
              session_id: sessionId,
              title: tempUserMsg.content.slice(0, 50),
              created_at: tempUserMsg.created_at,
              updated_at: data.created_at || new Date().toISOString(),
              total_messages: 2,
              messages: [
                {
                  id: 1,
                  role: tempUserMsg.role,
                  content: tempUserMsg.content,
                  created_at: tempUserMsg.created_at,
                },
                assistantMsg,
              ],
            };
          }

          return {
            ...old,
            updated_at: data.created_at || new Date().toISOString(),
            total_messages: old.total_messages + 2,
            messages: [
              ...old.messages,
              {
                id: Date.now() - 1,
                role: tempUserMsg.role,
                content: tempUserMsg.content,
                created_at: tempUserMsg.created_at,
              },
              assistantMsg,
            ],
          };
        }
      );

      // Clear pending message queue
      setPendingMessages([]);

      // Invalidate queries so session lists update message counts and timestamps
      queryClient.invalidateQueries({ queryKey: sessionDetailQueryKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error, variables) => {
      const errorText =
        error.status === 503
          ? 'J.A.R.V.I.S. Neural Core is unreachable. Ensure Ollama is running on the host machine.'
          : error.status === 504
            ? 'Inference request timed out. Please try again.'
            : error.message || 'An unexpected error occurred while communicating with J.A.R.V.I.S.';

      // Mark the pending bot bubble with error state
      setPendingMessages((prev) =>
        prev.map((msg) => {
          if (msg.id === variables.tempBotMsg.id) {
            return {
              ...msg,
              isPending: false,
              isError: true,
              content: errorText,
            };
          }
          return msg;
        })
      );
    },
  });

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || chatMutation.isPending) return;

      // 1. Resolve or generate session ID
      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = generateNewSessionId();
        setActiveSessionId(sessionId);
      }

      const tempUserMsgId = `temp-user-${Date.now()}`;
      const tempBotMsgId = `temp-bot-${Date.now()}`;
      const nowIso = new Date().toISOString();

      // 2. Optimistic user message and pending assistant bubble
      const userMessage: ChatMessage = {
        id: tempUserMsgId,
        role: 'user',
        content: trimmed,
        created_at: nowIso,
      };

      const pendingBotMessage: ChatMessage = {
        id: tempBotMsgId,
        role: 'assistant',
        content: '',
        created_at: nowIso,
        isPending: true,
      };

      setPendingMessages([userMessage, pendingBotMessage]);

      // 3. Dispatch to POST /chat
      chatMutation.mutate({
        sessionId,
        messageText: trimmed,
        tempUserMsg: userMessage,
        tempBotMsg: pendingBotMessage,
      });
    },
    [activeSessionId, chatMutation, generateNewSessionId, setActiveSessionId]
  );

  // Combine loaded SQLite historical messages with any local pending messages
  const combinedMessages: ChatMessage[] = useMemo(() => {
    if (!activeSessionId) {
      return pendingMessages;
    }

    const loadedMessages: ChatMessage[] = (sessionDetail?.messages || []).map((m) => ({
      id: m.id,
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content,
      created_at: m.created_at,
    }));

    return [...loadedMessages, ...pendingMessages];
  }, [activeSessionId, sessionDetail?.messages, pendingMessages]);

  // Start fresh conversation: clear activeSessionId and pending state
  const startNewConversation = useCallback(() => {
    setActiveSessionId(null);
    setPendingMessages([]);
  }, [setActiveSessionId]);

  return {
    messages: combinedMessages,
    sendMessage,
    startNewConversation,
    isLoadingSession,
    isGenerating: chatMutation.isPending,
  };
}
