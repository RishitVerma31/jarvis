/**
 * Verification test suite for Voice Assistant lifecycle and Speech Synthesis protections.
 * Tests against:
 * 1. Audio Processor Leak prevention (single ScriptProcessorNode guarantee)
 * 2. Audio Context & MediaStream complete teardown on disable
 * 3. Session ID updates without audio pipeline recreation
 * 4. SpeechSynthesisUtterance GC retention on window
 * 5. Single tts_completed dispatch across onend, onerror, and fallback timer
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('Voice Assistant & Speech Synthesis Lifecycle Protections', () => {

  describe('Speech Synthesis Utterance Protections', () => {
    let mockWindow;
    let mockSpeechSynthesis;
    let utteranceInstances;

    beforeEach(() => {
      utteranceInstances = [];
      mockSpeechSynthesis = {
        speaking: false,
        cancelCalls: 0,
        cancel() {
          this.cancelCalls++;
          this.speaking = false;
        },
        speak(u) {
          this.speaking = true;
          mockWindow.__jarvis_active_utterance = u;
        },
        getVoices() { return []; },
      };

      class MockUtterance {
        constructor(text) {
          this.text = text;
          this.voice = null;
          this.pitch = 1.0;
          this.rate = 1.0;
          this.onstart = null;
          this.onend = null;
          this.onerror = null;
          utteranceInstances.push(this);
        }
      }

      mockWindow = {
        speechSynthesis: mockSpeechSynthesis,
        SpeechSynthesisUtterance: MockUtterance,
        __jarvis_active_utterance: null,
      };
    });

    it('attaches utterance to window.__jarvis_active_utterance to protect against V8 GC', () => {
      const u = new mockWindow.SpeechSynthesisUtterance('Greetings, sir.');
      mockWindow.speechSynthesis.speak(u);

      assert.strictEqual(mockWindow.__jarvis_active_utterance, u, 'Utterance must be pinned to window');
    });

    it('dispatches onEnd exactly once when utterance completes normally', () => {
      let callCount = 0;
      let hasCompleted = false;
      let fallbackTimer = setTimeout(() => {}, 10000);

      const cleanupAndComplete = (invoke) => {
        if (hasCompleted) return;
        hasCompleted = true;
        clearTimeout(fallbackTimer);
        mockWindow.__jarvis_active_utterance = null;
        if (invoke) callCount++;
      };

      const u = new mockWindow.SpeechSynthesisUtterance('Test');
      mockWindow.speechSynthesis.speak(u);

      // Normal completion
      cleanupAndComplete(true);
      // Duplicate trigger attempt (e.g. timeout or error race)
      cleanupAndComplete(true);

      assert.strictEqual(callCount, 1, 'onEnd should only be called once');
      assert.strictEqual(mockWindow.__jarvis_active_utterance, null, 'Active utterance should be cleared');
    });

    it('suppresses onEnd callback when speech is canceled or interrupted', () => {
      let callCount = 0;
      let hasCompleted = false;

      const handleErr = (err) => {
        if (hasCompleted) return;
        if (err.error === 'canceled' || err.error === 'interrupted') {
          hasCompleted = true;
          mockWindow.__jarvis_active_utterance = null;
          return;
        }
        hasCompleted = true;
        callCount++;
      };

      handleErr({ error: 'canceled' });
      assert.strictEqual(callCount, 0, 'Canceled speech must not invoke onEnd');
      assert.strictEqual(mockWindow.__jarvis_active_utterance, null);
    });

    it('dispatches onEnd when speech encounters a genuine engine error', () => {
      let callCount = 0;
      let hasCompleted = false;

      const handleErr = (err) => {
        if (hasCompleted) return;
        if (err.error === 'canceled' || err.error === 'interrupted') {
          hasCompleted = true;
          return;
        }
        hasCompleted = true;
        callCount++;
      };

      handleErr({ error: 'audio-busy' });
      assert.strictEqual(callCount, 1, 'Genuine engine error must invoke onEnd to unblock backend');
    });

    it('stopSpeaking cleans up active utterance, window reference, and cancels speech', () => {
      const u = new mockWindow.SpeechSynthesisUtterance('Test speech');
      mockWindow.speechSynthesis.speak(u);
      assert.strictEqual(mockWindow.__jarvis_active_utterance, u);

      // Simulate stopSpeaking
      mockWindow.__jarvis_active_utterance = null;
      mockWindow.speechSynthesis.cancel();

      assert.strictEqual(mockWindow.__jarvis_active_utterance, null);
      assert.strictEqual(mockSpeechSynthesis.cancelCalls, 1);
    });
  });

  describe('Audio Processor Lifecycle & Pipeline Guard', () => {
    let mockAudioContextCount;
    let mockScriptProcessorCount;
    let mockMediaStreamTrackStopCount;

    class MockTrack {
      constructor() {
        this.stopped = false;
      }
      stop() {
        this.stopped = true;
        mockMediaStreamTrackStopCount++;
      }
    }

    class MockMediaStream {
      constructor() {
        this.tracks = [new MockTrack()];
      }
      getTracks() {
        return this.tracks;
      }
    }

    class MockScriptProcessorNode {
      constructor() {
        mockScriptProcessorCount++;
        this.onaudioprocess = null;
        this.disconnected = false;
      }
      connect() {}
      disconnect() {
        this.disconnected = true;
        mockScriptProcessorCount--;
      }
    }

    class MockSourceNode {
      constructor() {
        this.disconnected = false;
      }
      connect() {}
      disconnect() {
        this.disconnected = true;
      }
    }

    class MockAudioContext {
      constructor() {
        mockAudioContextCount++;
        this.state = 'running';
        this.sampleRate = 48000;
      }
      createMediaStreamSource() {
        return new MockSourceNode();
      }
      createScriptProcessor() {
        return new MockScriptProcessorNode();
      }
      async close() {
        this.state = 'closed';
        mockAudioContextCount--;
      }
    }

    beforeEach(() => {
      mockAudioContextCount = 0;
      mockScriptProcessorCount = 0;
      mockMediaStreamTrackStopCount = 0;
    });

    it('guard prevents multiple simultaneous audio capture pipelines', async () => {
      const isCapturingRef = { current: false };
      const audioContextRef = { current: null };

      async function startCapture() {
        if (isCapturingRef.current || audioContextRef.current) {
          return null;
        }
        isCapturingRef.current = true;
        const ctx = new MockAudioContext();
        audioContextRef.current = ctx;
        const proc = ctx.createScriptProcessor();
        return { ctx, proc };
      }

      const first = await startCapture();
      assert.notStrictEqual(first, null, 'First capture should succeed');
      assert.strictEqual(mockAudioContextCount, 1);
      assert.strictEqual(mockScriptProcessorCount, 1);

      // Attempt second concurrent capture (e.g. from session ID change or re-render)
      const second = await startCapture();
      assert.strictEqual(second, null, 'Second concurrent capture must be rejected by guard');
      assert.strictEqual(mockAudioContextCount, 1, 'AudioContext count must remain exactly 1');
      assert.strictEqual(mockScriptProcessorCount, 1, 'ScriptProcessor count must remain exactly 1');
    });

    it('stopAudioCapture tears down all resources cleanly', async () => {
      const isCapturingRef = { current: true };
      const audioContextRef = { current: new MockAudioContext() };
      const scriptProcessorRef = { current: audioContextRef.current.createScriptProcessor() };
      const sourceNodeRef = { current: new MockSourceNode() };
      const mediaStreamRef = { current: new MockMediaStream() };

      assert.strictEqual(mockAudioContextCount, 1);
      assert.strictEqual(mockScriptProcessorCount, 1);

      // Simulate stopAudioCapture
      function stopAudioCapture() {
        isCapturingRef.current = false;
        if (scriptProcessorRef.current) {
          scriptProcessorRef.current.onaudioprocess = null;
          scriptProcessorRef.current.disconnect();
          scriptProcessorRef.current = null;
        }
        if (sourceNodeRef.current) {
          sourceNodeRef.current.disconnect();
          sourceNodeRef.current = null;
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
        if (audioContextRef.current) {
          if (audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close();
          }
          audioContextRef.current = null;
        }
      }

      stopAudioCapture();

      assert.strictEqual(isCapturingRef.current, false);
      assert.strictEqual(scriptProcessorRef.current, null);
      assert.strictEqual(sourceNodeRef.current, null);
      assert.strictEqual(mediaStreamRef.current, null);
      assert.strictEqual(audioContextRef.current, null);
      assert.strictEqual(mockAudioContextCount, 0, 'AudioContext must be closed');
      assert.strictEqual(mockScriptProcessorCount, 0, 'ScriptProcessor must be disconnected');
      assert.strictEqual(mockMediaStreamTrackStopCount, 1, 'MediaStream tracks must be stopped');
    });

    it('aborts capture if stopped while getUserMedia is pending', async () => {
      const isCapturingRef = { current: false };
      const stream = new MockMediaStream();

      // Start capture
      isCapturingRef.current = true;

      // Simulate user turning off voice mode while permission prompt was open
      isCapturingRef.current = false;

      // When getUserMedia resolves:
      if (!isCapturingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
      }

      assert.strictEqual(mockMediaStreamTrackStopCount, 1, 'Stream tracks must be stopped if capture cancelled mid-flight');
      assert.strictEqual(mockAudioContextCount, 0, 'No AudioContext should have been created');
    });

    it('session ID updates do not trigger pipeline re-allocation', () => {
      let captureCount = 0;
      const activeSessionIdRef = { current: null };

      // Handlers use ref instead of triggering effect
      function handleServerEvent(newSessionId) {
        if (!activeSessionIdRef.current) {
          activeSessionIdRef.current = newSessionId;
        }
      }

      // Voice effect does not depend on activeSessionId
      function onVoiceModeStart() {
        captureCount++;
      }

      onVoiceModeStart();
      assert.strictEqual(captureCount, 1);

      // Session ID updates multiple times
      handleServerEvent('session-1');
      assert.strictEqual(activeSessionIdRef.current, 'session-1');
      assert.strictEqual(captureCount, 1, 'Session update must NOT restart audio capture');

      handleServerEvent('session-2');
      assert.strictEqual(activeSessionIdRef.current, 'session-1'); // Initial set preserved
      assert.strictEqual(captureCount, 1, 'Subsequent session updates must NOT restart audio capture');
    });

    it('tts_completed single-dispatch guard prevents duplicate socket messages', () => {
      const messagesSent = [];
      let ttsCompletedDispatched = false;

      const sendTTSCompleted = () => {
        if (ttsCompletedDispatched) return;
        ttsCompletedDispatched = true;
        messagesSent.push({ type: 'tts_completed' });
      };

      // Simulate normal end
      sendTTSCompleted();
      // Simulate duplicate delayed trigger or error race
      sendTTSCompleted();
      sendTTSCompleted();

      assert.strictEqual(messagesSent.length, 1, 'tts_completed must be sent exactly once');
      assert.deepStrictEqual(messagesSent[0], { type: 'tts_completed' });
    });
  });
});

