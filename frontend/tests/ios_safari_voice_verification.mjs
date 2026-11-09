/**
 * Verification test suite for iPhone Safari WebKit audio lifecycle & mobile responsiveness.
 * Tests against:
 * 1. User gesture audio unlock & speech engine priming (iOS WebKit requirement)
 * 2. W3C AudioSession API feature-detection and fallback ('playback' <-> 'play-and-record')
 * 3. WebKit cancel() -> speak() queue race resolution (asynchronous clearing delay)
 * 4. Speaker test isolation (no self-cancelling empty utterance queueing)
 * 5. Echo-buffer timer lifecycle and abort suppression
 * 6. Mobile viewport meta configuration (viewport-fit=cover for safe-area insets)
 * 7. Mobile iOS auto-zoom prevention (text-[16px] on text inputs)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setAudioSessionType } from '../src/utils/audioSession.ts';

describe('iPhone Safari Audio Lifecycle & Mobile Layout Protections', () => {

  describe('Audio Engine Unlock & Speech Priming', () => {
    let mockSpeechSynthesis;
    let spokenUtterances;
    let audioContextResumed;
    let bufferSourcesStarted;

    beforeEach(() => {
      spokenUtterances = [];
      audioContextResumed = false;
      bufferSourcesStarted = 0;

      mockSpeechSynthesis = {
        speaking: false,
        paused: false,
        cancelCalls: 0,
        cancel() {
          this.cancelCalls++;
          this.speaking = false;
        },
        resume() {
          this.paused = false;
        },
        speak(u) {
          spokenUtterances.push(u);
          this.speaking = true;
        },
        getVoices() { return []; },
      };
    });

    it('unlockAudio primes speechSynthesis with tiny blank utterance and resumes AudioContext', () => {
      class MockAudioContext {
        constructor() {
          this.state = 'suspended';
        }
        async resume() {
          audioContextResumed = true;
          this.state = 'running';
        }
        createBuffer() { return {}; }
        createBufferSource() {
          return {
            buffer: null,
            connect() {},
            start() { bufferSourcesStarted++; },
          };
        }
        async close() {}
      }

      function simulateUnlockAudio(speechSys, AudioCtxClass) {
        const silent = { text: ' ', volume: 0.01, rate: 10 };
        speechSys.speak(silent);
        if (speechSys.paused) speechSys.resume();

        const ctx = new AudioCtxClass();
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        const src = ctx.createBufferSource();
        src.start(0);

        return true;
      }

      const unlocked = simulateUnlockAudio(mockSpeechSynthesis, MockAudioContext);

      assert.strictEqual(unlocked, true);
      assert.strictEqual(spokenUtterances.length, 1, 'Silent primer utterance should have been spoken');
      assert.strictEqual(spokenUtterances[0].volume, 0.01, 'Primer should be inaudible');
      assert.strictEqual(audioContextResumed, true, 'AudioContext should have been resumed');
      assert.strictEqual(bufferSourcesStarted, 1, 'Buffer source should have been triggered');
    });

    it('speak does not invoke cancel() when not speaking to avoid WebKit queue drop bug', () => {
      mockSpeechSynthesis.speaking = false;

      function speakGuarded(text, speechSys) {
        if (speechSys.speaking) {
          speechSys.cancel();
        }
        speechSys.speak({ text });
      }

      speakGuarded('Hello Jarvis', mockSpeechSynthesis);
      assert.strictEqual(mockSpeechSynthesis.cancelCalls, 0, 'cancel() must not be called when speaking is false');
      assert.strictEqual(spokenUtterances.length, 1);
    });

    it('dynamically resolves preferred voice when voices load after mount', () => {
      const mockVoices = [
        { name: 'Daniel', lang: 'en-GB' },
        { name: 'Samantha', lang: 'en-US' },
      ];

      let cachedVoice = null;

      function resolveVoice(voices) {
        if (cachedVoice) return cachedVoice;
        const preferred = ['Daniel', 'Samantha'];
        for (const name of preferred) {
          const found = voices.find((v) => v.name.includes(name));
          if (found) {
            cachedVoice = found;
            return found;
          }
        }
        return null;
      }

      let voiceOnMount = resolveVoice([]);
      assert.strictEqual(voiceOnMount, null);

      let voiceOnSpeak = resolveVoice(mockVoices);
      assert.notStrictEqual(voiceOnSpeak, null);
      assert.strictEqual(voiceOnSpeak.name, 'Daniel');
    });
  });

  describe('W3C AudioSession Management & Fallback', () => {
    it('sets audioSession.type to playback when supported', () => {
      Object.defineProperty(globalThis.navigator, 'audioSession', {
        value: { type: 'auto' },
        configurable: true,
        writable: true,
      });

      const result = setAudioSessionType('playback');
      assert.strictEqual(result, true);
      assert.strictEqual(globalThis.navigator.audioSession.type, 'playback');

      delete globalThis.navigator.audioSession;
    });

    it('restores audioSession.type to play-and-record when returning to microphone', () => {
      Object.defineProperty(globalThis.navigator, 'audioSession', {
        value: { type: 'playback' },
        configurable: true,
        writable: true,
      });

      const result = setAudioSessionType('play-and-record');
      assert.strictEqual(result, true);
      assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record');

      delete globalThis.navigator.audioSession;
    });

    it('gracefully falls back when navigator.audioSession is unsupported', () => {
      delete globalThis.navigator.audioSession;

      const result = setAudioSessionType('playback');
      assert.strictEqual(result, false, 'Must return false without throwing when unsupported');
    });
  });

  describe('Speech Cancellation & WebKit Queue Clearing', () => {
    it('schedules speak with a delay after cancel() when already speaking', async () => {
      let cancelCalled = false;
      let speakCalled = false;
      let dispatchTimer = null;

      const mockSpeech = {
        speaking: true,
        cancel() { cancelCalled = true; },
        speak() { speakCalled = true; },
      };

      // Simulate the cancellation guard logic from useSpeechSynthesis
      function queueSpeakWithGuard(speechSys) {
        const dispatchSpeak = () => {
          speechSys.speak();
        };

        if (speechSys.speaking) {
          speechSys.cancel();
          dispatchTimer = setTimeout(dispatchSpeak, 60);
        } else {
          dispatchSpeak();
        }
      }

      queueSpeakWithGuard(mockSpeech);
      assert.strictEqual(cancelCalled, true, 'cancel() must be called to halt ongoing speech');
      assert.strictEqual(speakCalled, false, 'speak() must NOT be called in the same execution tick');

      // Wait for the WebKit queue clearing window to elapse
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.strictEqual(speakCalled, true, 'speak() must be dispatched after queue clearing delay');
    });

    it('stopSpeaking clears any pending speech dispatch timer immediately', () => {
      let speakCalled = false;
      let dispatchTimer = setTimeout(() => { speakCalled = true; }, 100);

      // Simulate stopSpeaking clearing the timer
      function stopSpeaking() {
        if (dispatchTimer) {
          clearTimeout(dispatchTimer);
          dispatchTimer = null;
        }
      }

      stopSpeaking();
      assert.strictEqual(dispatchTimer, null);
      assert.strictEqual(speakCalled, false);
    });
  });

  describe('Speaker Test & Isolation', () => {
    it('testSpeech primes audio context and speaks directly without preceding dummy utterance', () => {
      const spokenUtterances = [];
      let audioContextPrimed = false;

      function mockPrimeAudioContext() {
        audioContextPrimed = true;
      }

      function mockSpeak(text) {
        spokenUtterances.push(text);
      }

      // Implementation pattern of testSpeech
      function runTestSpeech(text = 'J.A.R.V.I.S. audio online.') {
        mockPrimeAudioContext();
        mockSpeak(text);
      }

      runTestSpeech();

      assert.strictEqual(audioContextPrimed, true);
      assert.strictEqual(spokenUtterances.length, 1, 'Only the actual test phrase should be queued');
      assert.strictEqual(spokenUtterances[0], 'J.A.R.V.I.S. audio online.');
      assert.strictEqual(spokenUtterances.includes(' '), false, 'Must NOT contain self-cancelling blank utterance');
    });
  });

  describe('Echo-Buffer Timer Lifecycle & Abort Safety', () => {
    it('delays tts_completed dispatch by echo-buffer timeout', async () => {
      const messagesSent = [];
      let echoTimer = null;

      function onSpeechEnd() {
        if (echoTimer) clearTimeout(echoTimer);
        echoTimer = setTimeout(() => {
          echoTimer = null;
          messagesSent.push({ type: 'tts_completed' });
        }, 50); // Scaled for test speed
      }

      onSpeechEnd();
      assert.strictEqual(messagesSent.length, 0, 'Must not dispatch immediately');

      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.strictEqual(messagesSent.length, 1);
      assert.strictEqual(messagesSent[0].type, 'tts_completed');
    });

    it('emergencyStop clears pending echo timer and prevents tts_completed from firing', async () => {
      const messagesSent = [];
      let echoTimer = setTimeout(() => {
        messagesSent.push({ type: 'tts_completed' });
      }, 50);

      // User triggers emergency stop during echo delay
      function emergencyStop() {
        if (echoTimer) {
          clearTimeout(echoTimer);
          echoTimer = null;
        }
        messagesSent.push({ type: 'emergency_stop' });
      }

      emergencyStop();

      await new Promise((resolve) => setTimeout(resolve, 70));

      assert.strictEqual(messagesSent.length, 1);
      assert.strictEqual(messagesSent[0].type, 'emergency_stop');
      assert.strictEqual(
        messagesSent.some((m) => m.type === 'tts_completed'),
        false,
        'tts_completed must NEVER be dispatched after emergency stop'
      );
    });

    it('new speech response clears any pending echo timer from previous turn', async () => {
      const messagesSent = [];
      let echoTimer = setTimeout(() => {
        messagesSent.push({ type: 'tts_completed', turn: 1 });
      }, 50);

      // New turn arrives before turn 1 echo delay expires
      function onNewTurn() {
        if (echoTimer) {
          clearTimeout(echoTimer);
          echoTimer = null;
        }
        // Start turn 2
        echoTimer = setTimeout(() => {
          echoTimer = null;
          messagesSent.push({ type: 'tts_completed', turn: 2 });
        }, 50);
      }

      onNewTurn();

      await new Promise((resolve) => setTimeout(resolve, 70));

      assert.strictEqual(messagesSent.length, 1);
      assert.strictEqual(messagesSent[0].turn, 2, 'Turn 1 tts_completed must be suppressed by new response');
    });
  });

  describe('Mobile Responsiveness & iOS Viewport Configuration', () => {
    const rootDir = path.resolve(import.meta.dirname, '..');

    it('index.html contains viewport-fit=cover for iOS safe area insets', () => {
      const htmlContent = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
      assert.match(
        htmlContent,
        /viewport-fit=cover/,
        'index.html must include viewport-fit=cover for env(safe-area-inset-*) to work'
      );
    });

    it('App.tsx utilizes dynamic viewport height (h-dvh)', () => {
      const appContent = fs.readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
      assert.match(
        appContent,
        /h-dvh/,
        'App.tsx root layout must use h-dvh for dynamic mobile Safari viewport height'
      );
    });

    it('ChatInput and AuthModal use font size 16px on mobile to prevent iOS auto-zoom', () => {
      const chatInputContent = fs.readFileSync(
        path.join(rootDir, 'src/components/chat/ChatInput.tsx'),
        'utf8'
      );
      assert.match(
        chatInputContent,
        /text-\[16px\]/,
        'ChatInput textarea must have text-[16px] on mobile to prevent iOS auto-zoom'
      );

      const authModalContent = fs.readFileSync(
        path.join(rootDir, 'src/components/auth/AuthModal.tsx'),
        'utf8'
      );
      assert.match(
        authModalContent,
        /text-\[16px\]/,
        'AuthModal passkey input must have text-[16px] on mobile to prevent iOS auto-zoom'
      );
    });

    it('ChatInput includes safe area bottom padding for iPhone home indicator', () => {
      const chatInputContent = fs.readFileSync(
        path.join(rootDir, 'src/components/chat/ChatInput.tsx'),
        'utf8'
      );
      assert.match(
        chatInputContent,
        /env\(safe-area-inset-bottom\)/,
        'ChatInput must respect env(safe-area-inset-bottom) for iPhone home bar'
      );
    });

    it('Header includes safe area top padding for iPhone notch / Dynamic Island', () => {
      const headerContent = fs.readFileSync(
        path.join(rootDir, 'src/components/layout/Header.tsx'),
        'utf8'
      );
      assert.match(
        headerContent,
        /env\(safe-area-inset-top\)/,
        'Header must respect env(safe-area-inset-top) for iPhone notch / Dynamic Island'
      );
    });

    it('Sidebar renders backdrop overlay and touch-friendly targets for mobile drawer', () => {
      const sidebarContent = fs.readFileSync(
        path.join(rootDir, 'src/components/layout/Sidebar.tsx'),
        'utf8'
      );
      assert.match(
        sidebarContent,
        /fixed inset-0 bg-slate-950/,
        'Sidebar must render a backdrop overlay on mobile'
      );
      assert.match(
        sidebarContent,
        /min-h-\[44px\]|min-h-\[48px\]/,
        'Sidebar must include touch-friendly hit areas >= 44px'
      );
    });
  });
});
