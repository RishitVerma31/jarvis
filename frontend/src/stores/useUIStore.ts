import { create } from 'zustand';

interface UIState {
  // Currently selected session ID (or null for a brand new chat)
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  // Responsive sidebar drawer toggle
  isSidebarOpen: boolean;
  setSidebarOpen: (isOpen: boolean) => void;
  toggleSidebar: () => void;

  // Input draft text
  draftMessage: string;
  setDraftMessage: (msg: string) => void;

  // Audio / Speech settings
  isAutoSpeakEnabled: boolean;
  toggleAutoSpeak: () => void;
  setAutoSpeak: (enabled: boolean) => void;

  // Hands-Free Voice Assistant (Stage 2.6)
  isVoiceModeActive: boolean;
  setVoiceModeActive: (active: boolean) => void;
  toggleVoiceMode: () => void;
  isVoiceMuted: boolean;
  setVoiceMuted: (muted: boolean) => void;
  toggleVoiceMuted: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  isSidebarOpen: true,
  setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  draftMessage: '',
  setDraftMessage: (msg) => set({ draftMessage: msg }),

  isAutoSpeakEnabled: false,
  toggleAutoSpeak: () => set((state) => ({ isAutoSpeakEnabled: !state.isAutoSpeakEnabled })),
  setAutoSpeak: (enabled) => set({ isAutoSpeakEnabled: enabled }),

  isVoiceModeActive: false,
  setVoiceModeActive: (active) => set({ isVoiceModeActive: active }),
  toggleVoiceMode: () => set((state) => ({ isVoiceModeActive: !state.isVoiceModeActive })),
  isVoiceMuted: false,
  setVoiceMuted: (muted) => set({ isVoiceMuted: muted }),
  toggleVoiceMuted: () => set((state) => ({ isVoiceMuted: !state.isVoiceMuted })),
}));
