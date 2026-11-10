import { create } from 'zustand';
import type { VoiceState, VoiceMetrics } from '../types/voice';

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

  // Voice Live Pipeline Activity & Telemetry
  voiceState: VoiceState;
  setVoiceState: (state: VoiceState) => void;
  voiceStatusMessage: string;
  setVoiceStatusMessage: (msg: string) => void;
  voiceTranscript: string | null;
  setVoiceTranscript: (transcript: string | null) => void;
  voiceAudioLevel: number;
  setVoiceAudioLevel: (level: number) => void;
  voiceLastMetrics: VoiceMetrics | null;
  setVoiceLastMetrics: (metrics: VoiceMetrics | null) => void;
  voiceIsFollowUp: boolean;
  setVoiceIsFollowUp: (followUp: boolean) => void;
  onEmergencyStop?: () => void;
  setOnEmergencyStop: (fn: (() => void) | undefined) => void;
  triggerEmergencyStop: () => void;

  // Security & Passkey Authentication (Stage B)
  isAuthModalOpen: boolean;
  setAuthModalOpen: (open: boolean) => void;
  isAuthenticated: boolean;
  setAuthenticated: (authenticated: boolean) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
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

  voiceState: 'STANDBY',
  setVoiceState: (state) => set({ voiceState: state }),
  voiceStatusMessage: 'Voice Assistant offline',
  setVoiceStatusMessage: (msg) => set({ voiceStatusMessage: msg }),
  voiceTranscript: null,
  setVoiceTranscript: (transcript) => set({ voiceTranscript: transcript }),
  voiceAudioLevel: 0,
  setVoiceAudioLevel: (level) => set({ voiceAudioLevel: level }),
  voiceLastMetrics: null,
  setVoiceLastMetrics: (metrics) => set({ voiceLastMetrics: metrics }),
  voiceIsFollowUp: false,
  setVoiceIsFollowUp: (followUp) => set({ voiceIsFollowUp: followUp }),
  onEmergencyStop: undefined,
  setOnEmergencyStop: (fn) => set({ onEmergencyStop: fn }),
  triggerEmergencyStop: () => {
    const fn = get().onEmergencyStop;
    if (fn) fn();
  },

  isAuthModalOpen: false,
  setAuthModalOpen: (open) => set({ isAuthModalOpen: open }),
  isAuthenticated: false,
  setAuthenticated: (authenticated) => set({ isAuthenticated: authenticated }),
}));
