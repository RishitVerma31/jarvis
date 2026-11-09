import React from 'react';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { ChatContainer } from './components/chat/ChatContainer';
import { ChatInput } from './components/chat/ChatInput';
import { useChat } from './hooks/useChat';

export const App: React.FC = () => {
  const { messages, sendMessage, startNewConversation, isGenerating } = useChat();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 font-sans text-slate-100">
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
