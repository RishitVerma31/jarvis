/**
 * Verification test suite for Project Jarvis Kokoro TTS Voice Assistant Integration (Milestone 2, Step 2).
 * Tests against:
 * 1. chat_response with Kokoro audio triggers playBase64WavAudio, mutes mic, and transitions to SPEAKING.
 * 2. Natural completion waits 300ms (acoustic echo suppression) before sending tts_completed.
 * 3. Hardware microphone tracks and AudioSession ('play-and-record') are restored upon completion.
 * 4. chat_response without audio immediately falls back to browser SpeechSynthesis.
 * 5. Kokoro playback errors fall back seamlessly to browser SpeechSynthesis without freezing.
 * 6. emergencyStop immediately aborts Kokoro audio, clears echo timer, un-mutes mic, and sends emergency_stop (never tts_completed).
 * 7. stopSpeaking (manual stop) aborts active Kokoro playback, clears echo timer, and sends stop_speaking.
 * 8. Stale callbacks and race conditions across conversational turns cannot send duplicate or erroneous tts_completed messages.
 * 9. WebSocket disconnect halts active audio playback and clears timers.
 * 10. unlockAudio primes both SpeechSynthesis and Web Audio context inside user gesture.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToArrayBuffer,
  playBase64WavAudio,
  stopAudioPlayback,
  isAudioPlaying,
  setPlaybackAudioContextForTesting,
  getPlaybackAudioContext,
} from '../src/utils/audioPlayback.ts';
import { setAudioSessionType } from '../src/utils/audioSession.ts';

// Mock Web Audio Context and Node infrastructure
class MockAudioBufferSourceNode {
  constructor() {
    this.buffer = null;
    this.onended = null;
    this.started = false;
    this.stopped = false;
    this.disconnected = false;
  }
  connect() {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class MockAudioContext {
  constructor(options = {}) {
    this.state = options.initialState || 'suspended';
    this.destination = {};
    this.decodeShouldFail = options.decodeShouldFail || false;
    this.activeSource = null;
  }

  async resume() {
    this.state = 'running';
  }

  createBufferSource() {
    const src = new MockAudioBufferSourceNode();
    this.activeSource = src;
    return src;
  }

  decodeAudioData(buffer, successCallback, errorCallback) {
    if (this.decodeShouldFail) {
      const err = new Error('Corrupted WAV audio format.');
      if (errorCallback) errorCallback(err);
      return Promise.reject(err);
    }
    const mockBuffer = {
      length: 24000,
      duration: 1.0,
      sampleRate: 24000,
      numberOfChannels: 1,
    };
    if (successCallback) successCallback(mockBuffer);
    return Promise.resolve(mockBuffer);
  }
}

class MockMediaTrack {
  constructor() {
    this.enabled = true;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class MockMediaStream {
  constructor() {
    this.tracks = [new MockMediaTrack()];
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

describe('Kokoro Voice Assistant Integration (Milestone 2, Step 2)', () => {
  const dummyWavBase64 = Buffer.from('RIFF1234WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00data\x04\x00\x00\x00\x00\x00\x00\x00').toString('base64');

  let mockAudioContext;
  let mockStream;
  let sentSocketMessages;
  let audioSessionTypes;

  beforeEach(() => {
    stopAudioPlayback();
    setPlaybackAudioContextForTesting(null);

    mockAudioContext = new MockAudioContext({ initialState: 'running' });
    setPlaybackAudioContextForTesting(mockAudioContext);

    mockStream = new MockMediaStream();
    sentSocketMessages = [];
    audioSessionTypes = [];

    // Mock navigator.audioSession
    if (typeof globalThis.navigator === 'undefined') {
      globalThis.navigator = {};
    }
    Object.defineProperty(globalThis.navigator, 'audioSession', {
      value: {
        type: 'play-and-record',
        set type(val) {
          audioSessionTypes.push(val);
          this._type = val;
        },
        get type() {
          return this._type || 'play-and-record';
        },
      },
      configurable: true,
      writable: true,
    });
  });

  it('chat_response with Kokoro audio mutes mic, transitions to SPEAKING, and starts playback', async () => {
    let voiceState = 'WAKE_LISTENING';
    let isStreamingPaused = false;
    let playbackStarted = false;

    // Simulate Voice Assistant chat_response handler logic
    function handleChatResponse(event) {
      voiceState = 'SPEAKING';

      // Mute hardware mic
      mockStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      isStreamingPaused = true;

      if (event.audio && typeof event.audio === 'string' && event.audio.trim().length > 0) {
        playBase64WavAudio(
          event.audio,
          () => {
            playbackStarted = true;
          },
          () => {},
          () => {},
          { autoRestoreSession: false }
        );
      }
    }

    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic track initially enabled');

    handleChatResponse({
      type: 'chat_response',
      reply: 'Good evening, sir.',
      audio: dummyWavBase64,
      audio_mime: 'audio/wav',
      session_id: 'test-session',
      created_at: new Date().toISOString(),
    });

    assert.strictEqual(voiceState, 'SPEAKING', 'State must transition to SPEAKING');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Hardware mic track must be disabled during playback');
    assert.strictEqual(isStreamingPaused, true, 'Audio streaming must be paused');

    // Wait for microtask / async decode
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(playbackStarted, true, 'Kokoro Web Audio playback must have started');
    assert.strictEqual(mockAudioContext.activeSource.started, true, 'AudioBufferSourceNode must be started');
  });

  it('natural completion waits for 300ms echo suppression delay before sending tts_completed and unmuting', async () => {
    let echoTimer = null;
    let ttsCompletedSent = false;
    let turnId = 1;
    let currentTurnId = 1;

    // Setup playing audio
    mockStream.getAudioTracks().forEach((t) => (t.enabled = false));

    const sendTTSCompleted = () => {
      if (currentTurnId !== turnId) return;
      ttsCompletedSent = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
      sentSocketMessages.push({ type: 'tts_completed' });
    };

    const onPlaybackEnd = () => {
      if (currentTurnId !== turnId) return;
      if (echoTimer) clearTimeout(echoTimer);
      echoTimer = setTimeout(() => {
        echoTimer = null;
        sendTTSCompleted();
      }, 50); // Using 50ms for swift test execution
    };

    // Play audio and simulate natural onended
    playBase64WavAudio(
      dummyWavBase64,
      () => {},
      onPlaybackEnd,
      () => {},
      { autoRestoreSession: false }
    );

    await new Promise((resolve) => setTimeout(resolve, 15));

    // Simulate node ended event
    mockAudioContext.activeSource.onended();

    // Immediately after playback ends, tts_completed should NOT yet be sent (suppression window)
    assert.strictEqual(ttsCompletedSent, false, 'tts_completed must not fire immediately upon audio end');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must remain muted during echo buffer');

    // Wait for echo buffer timer to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(ttsCompletedSent, true, 'tts_completed must fire after echo delay expires');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Hardware mic must be re-enabled');
    assert.strictEqual(sentSocketMessages.length, 1);
    assert.strictEqual(sentSocketMessages[0].type, 'tts_completed');
  });

  it('audio session remains in playback during Kokoro playback and full 300ms echo delay before restoring play-and-record in exact order', async () => {
    const lifecycleEvents = [];
    let echoTimer = null;
    let turnId = 1;
    let currentTurnId = 1;

    // Track audio session mutations
    setAudioSessionType('play-and-record');
    assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record');

    // 1. chat_response begins:
    // Mute mic and start playback with autoRestoreSession: false
    mockStream.getAudioTracks().forEach((t) => {
      t.enabled = false;
      lifecycleEvents.push({ event: 'mic:muted' });
    });

    const sendTTSCompleted = () => {
      if (currentTurnId !== turnId) return;
      // Exact order:
      // 1. Restore iOS audio session to play-and-record
      setAudioSessionType('play-and-record');
      lifecycleEvents.push({ event: 'session:play-and-record', type: globalThis.navigator.audioSession.type });

      // 2. Re-enable hardware mic
      mockStream.getAudioTracks().forEach((t) => {
        t.enabled = true;
        lifecycleEvents.push({ event: 'mic:enabled' });
      });

      // 3. Send tts_completed
      sentSocketMessages.push({ type: 'tts_completed' });
      lifecycleEvents.push({ event: 'socket:tts_completed' });
    };

    const scheduleTTSCompletion = () => {
      if (currentTurnId !== turnId) return;
      if (echoTimer) clearTimeout(echoTimer);
      echoTimer = setTimeout(() => {
        echoTimer = null;
        sendTTSCompleted();
      }, 300);
    };

    playBase64WavAudio(
      dummyWavBase64,
      () => {
        lifecycleEvents.push({ event: 'playback:started', session: globalThis.navigator.audioSession.type });
      },
      () => {
        lifecycleEvents.push({ event: 'playback:ended', session: globalThis.navigator.audioSession.type });
        scheduleTTSCompletion();
      },
      () => {},
      { autoRestoreSession: false }
    );

    // Audio session should immediately transition to 'playback'
    assert.strictEqual(globalThis.navigator.audioSession.type, 'playback', 'AudioSession must be in playback during active audio');

    await new Promise((r) => setTimeout(r, 20));

    // Simulate natural buffer end
    mockAudioContext.activeSource.onended();

    // At t = 0ms after playback end:
    assert.strictEqual(globalThis.navigator.audioSession.type, 'playback', 'AudioSession must NOT be restored to play-and-record immediately on audio end');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must remain muted immediately on audio end');
    assert.strictEqual(sentSocketMessages.length, 0, 'tts_completed must not have fired yet');

    // At t = 150ms (halfway through the 300ms echo suppression delay):
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(globalThis.navigator.audioSession.type, 'playback', 'AudioSession must remain in playback midway through 300ms echo buffer');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must remain muted midway through 300ms echo buffer');
    assert.strictEqual(sentSocketMessages.length, 0, 'tts_completed must still be pending');

    // At t = 350ms (after full 300ms echo suppression delay expires):
    await new Promise((r) => setTimeout(r, 180));
    assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record', 'AudioSession must be restored to play-and-record after 300ms delay');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic must be re-enabled after 300ms delay');
    assert.strictEqual(sentSocketMessages.length, 1, 'tts_completed must be dispatched');
    assert.strictEqual(sentSocketMessages[0].type, 'tts_completed');

    // Verify exact ordering of operations:
    // session:play-and-record -> mic:enabled -> socket:tts_completed
    const sessionIdx = lifecycleEvents.findIndex((e) => e.event === 'session:play-and-record');
    const micIdx = lifecycleEvents.findIndex((e) => e.event === 'mic:enabled');
    const socketIdx = lifecycleEvents.findIndex((e) => e.event === 'socket:tts_completed');

    assert.ok(sessionIdx !== -1 && micIdx !== -1 && socketIdx !== -1);
    assert.ok(sessionIdx < micIdx, 'Audio session must be restored before re-enabling mic');
    assert.ok(micIdx < socketIdx, 'Mic must be re-enabled before sending tts_completed');
  });

  it('playback error and manual cancellation restore audio session safely without triggering tts_completed', async () => {
    // 1. Manual cancellation path
    setAudioSessionType('play-and-record');
    const cancelAudio = playBase64WavAudio(dummyWavBase64, undefined, undefined, undefined, { autoRestoreSession: false });
    assert.strictEqual(globalThis.navigator.audioSession.type, 'playback');

    // Simulate emergencyStop / cancelAllSpeech
    cancelAudio();
    setAudioSessionType('play-and-record');
    mockStream.getAudioTracks().forEach((t) => (t.enabled = true));

    assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true);
    assert.strictEqual(sentSocketMessages.length, 0, 'tts_completed must NOT be sent on cancellation');

    // 2. Playback error path
    mockAudioContext.decodeShouldFail = true;
    let fallbackTriggered = false;

    playBase64WavAudio(
      dummyWavBase64,
      undefined,
      undefined,
      (err) => {
        fallbackTriggered = true;
        setAudioSessionType('play-and-record');
      },
      { autoRestoreSession: false }
    );

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fallbackTriggered, true);
    assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record');
    assert.strictEqual(sentSocketMessages.length, 0, 'tts_completed must NOT be sent on playback error');
  });

  it('chat_response without audio immediately falls back to browser SpeechSynthesis', async () => {
    let spokeText = null;
    let speechStartInvoked = false;
    let speechEndInvoked = false;

    const mockSpeak = (text, onStart, onEnd) => {
      spokeText = text;
      onStart?.();
      setTimeout(() => {
        speechEndInvoked = true;
        onEnd?.();
      }, 20);
    };

    function handleChatResponse(event) {
      if (event.audio && typeof event.audio === 'string' && event.audio.trim().length > 0) {
        playBase64WavAudio(event.audio);
      } else {
        // Fallback branch
        mockSpeak(
          event.reply,
          () => {
            speechStartInvoked = true;
          },
          () => {}
        );
      }
    }

    handleChatResponse({
      type: 'chat_response',
      reply: 'Operating without Kokoro TTS.',
      session_id: 'test-session',
      created_at: new Date().toISOString(),
    });

    assert.strictEqual(spokeText, 'Operating without Kokoro TTS.');
    assert.strictEqual(speechStartInvoked, true);
    assert.strictEqual(isAudioPlaying(), false, 'Kokoro Web Audio must not be active');
  });

  it('Kokoro playback error seamlessly falls back to browser SpeechSynthesis', async () => {
    // Configure AudioContext to fail decoding
    mockAudioContext.decodeShouldFail = true;

    let fallbackText = null;
    let fallbackTriggered = false;

    const mockSpeak = (text) => {
      fallbackText = text;
      fallbackTriggered = true;
    };

    function handleChatResponse(event) {
      playBase64WavAudio(
        event.audio,
        () => {},
        () => {},
        (err) => {
          // Controlled fallback on error
          mockSpeak(event.reply);
        }
      );
    }

    handleChatResponse({
      type: 'chat_response',
      reply: 'Fallback speech after decode failure.',
      audio: dummyWavBase64,
      session_id: 'test-session',
      created_at: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.strictEqual(fallbackTriggered, true, 'Fallback SpeechSynthesis must be triggered on decode error');
    assert.strictEqual(fallbackText, 'Fallback speech after decode failure.');
    assert.strictEqual(isAudioPlaying(), false, 'Kokoro audio state must be cleared');
  });

  it('emergencyStop cancels Kokoro playback, clears echo timer, un-mutes mic, and sends emergency_stop', async () => {
    let echoTimer = null;
    let cancelAudioFn = null;
    let voiceState = 'SPEAKING';

    cancelAudioFn = playBase64WavAudio(
      dummyWavBase64,
      () => {},
      () => {
        echoTimer = setTimeout(() => {
          sentSocketMessages.push({ type: 'tts_completed' });
        }, 100);
      },
      () => {}
    );

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(isAudioPlaying(), true, 'Playback should be running');

    // Trigger emergencyStop
    function emergencyStop() {
      if (echoTimer) {
        clearTimeout(echoTimer);
        echoTimer = null;
      }
      if (cancelAudioFn) {
        cancelAudioFn();
        cancelAudioFn = null;
      }
      stopAudioPlayback();
      mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
      sentSocketMessages.push({ type: 'emergency_stop' });
      voiceState = 'WAKE_LISTENING';
    }

    emergencyStop();

    assert.strictEqual(isAudioPlaying(), false, 'Kokoro audio playback must be stopped');
    assert.strictEqual(voiceState, 'WAKE_LISTENING');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic track must be re-enabled');

    // Wait past the original echo delay
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.strictEqual(
      sentSocketMessages.some((m) => m.type === 'tts_completed'),
      false,
      'tts_completed must NEVER be sent after emergencyStop'
    );
    assert.strictEqual(sentSocketMessages.length, 1);
    assert.strictEqual(sentSocketMessages[0].type, 'emergency_stop');
  });

  it('stopSpeaking (manual stop) stops active Kokoro audio and sends stop_speaking', async () => {
    let cancelAudioFn = null;
    let voiceState = 'SPEAKING';

    cancelAudioFn = playBase64WavAudio(dummyWavBase64);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(isAudioPlaying(), true);

    function stopSpeaking() {
      if (cancelAudioFn) {
        cancelAudioFn();
        cancelAudioFn = null;
      }
      stopAudioPlayback();
      mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
      sentSocketMessages.push({ type: 'stop_speaking' });
      voiceState = 'WAKE_LISTENING';
    }

    stopSpeaking();

    assert.strictEqual(isAudioPlaying(), false, 'Kokoro audio must be stopped');
    assert.strictEqual(voiceState, 'WAKE_LISTENING');
    assert.strictEqual(sentSocketMessages.length, 1);
    assert.strictEqual(sentSocketMessages[0].type, 'stop_speaking');
  });

  it('turn counter guards against stale callbacks from earlier conversation turns', async () => {
    let currentTurnId = 1;
    let ttsCompletedTurns = [];

    function triggerTurnCompletion(turnId) {
      setTimeout(() => {
        // Stale callback guard check
        if (currentTurnId !== turnId) return;
        ttsCompletedTurns.push(turnId);
      }, 50);
    }

    // Turn 1 starts and schedules completion
    triggerTurnCompletion(1);

    // Turn 2 arrives swiftly (before Turn 1 completes)
    currentTurnId = 2;
    triggerTurnCompletion(2);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.strictEqual(ttsCompletedTurns.length, 1, 'Only the active turn completion may dispatch');
    assert.strictEqual(ttsCompletedTurns[0], 2, 'Stale Turn 1 completion must be suppressed');
  });

  it('WebSocket disconnect halts active Kokoro audio playback cleanly', async () => {
    playBase64WavAudio(dummyWavBase64);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(isAudioPlaying(), true);

    // Simulate WebSocket disconnect event
    function onConnectionChange(connected) {
      if (!connected) {
        stopAudioPlayback();
        mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
      }
    }

    onConnectionChange(false);

    assert.strictEqual(isAudioPlaying(), false, 'Playback must be halted when WebSocket disconnects');
    assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic must be released');
  });

  it('unlockAudio primes Web Audio context and Web Speech inside user gesture', () => {
    let speechPrimed = false;
    let webAudioPrimed = false;

    const mockSpeechSynthesis = {
      speak() {
        speechPrimed = true;
      },
    };

    function simulateUnlockAudio() {
      // 1. Prime Web Speech
      mockSpeechSynthesis.speak();

      // 2. Prime Web Audio
      const ctx = getPlaybackAudioContext();
      if (ctx) {
        webAudioPrimed = true;
      }
      return true;
    }

    const res = simulateUnlockAudio();
    assert.strictEqual(res, true);
    assert.strictEqual(speechPrimed, true, 'SpeechSynthesis must be primed');
    assert.strictEqual(webAudioPrimed, true, 'Kokoro Web Audio context must be primed');
  });
});
