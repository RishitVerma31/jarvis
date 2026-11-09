import React, { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { ChatContainer } from './components/chat/ChatContainer';
import { ChatInput } from './components/chat/ChatInput';
import { AuthModal } from './components/auth/AuthModal';
import { useChat } from './hooks/useChat';
import { useUIStore } from './stores/useUIStore';
import {
  isAuthenticated as checkIsAuth,
  clearAuthToken,
  UNAUTHORIZED_EVENT,
  AUTH_CHANGE_EVENT,
} from './services/auth';

export const App: React.FC = () => {
  const queryClient = useQueryClient();
  const { messages, sendMessage, startNewConversation, isGenerating } = useChat();
  const { setAuthModalOpen, setAuthenticated } = useUIStore();

  // Initialize auth state and listen for security events
  useEffect(() => {
    const hasKey = checkIsAuth();
    setAuthenticated(hasKey);
    if (!hasKey) {
      setAuthModalOpen(true);
    }

    const handleUnauthorized = () => {
      clearAuthToken();
      setAuthenticated(false);
      queryClient.clear();
      setAuthModalOpen(true);
    };

    const handleAuthChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ isAuthenticated: boolean }>;
      if (customEvent.detail?.isAuthenticated !== undefined) {
        setAuthenticated(customEvent.detail.isAuthenticated);
      }
    };

    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    window.addEventListener(AUTH_CHANGE_EVENT, handleAuthChange);

    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
      window.removeEventListener(AUTH_CHANGE_EVENT, handleAuthChange);
    };
  }, [setAuthenticated, setAuthModalOpen, queryClient]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 font-sans text-slate-100">
      {/* Security Authorization Modal */}
      <AuthModal />

      {/* Collapsible Sidebar with New Conversation action */}
      <Sidebar onNewConversation={startNewConversation} />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-gradient-to-b from-slate-950 via-slate-900/60 to-slate-950">
        <Header />
        <ChatContainer
          messages={messages}
          onSuggestionClick={sendMessage}
        />
        <ChatInput
          onSend={sendMessage}
          disabled={isGenerating}
        />
      </main>
    </div>
  );
};

export default App;
