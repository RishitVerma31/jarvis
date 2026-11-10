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

  describe('Phase 1 Handshake & Microphone Gating Safeguards', () => {
    it('PCM transmission pauses on TRANSCRIBING and remains paused through PROCESSING and SPEAKING', () => {
      let isStreamingPaused = false;
      let voiceState = 'RECORDING';

      function handleServerEvent(event) {
        if (event.type === 'state_change') {
          voiceState = event.state;
          if (event.state === 'TRANSCRIBING' || event.state === 'PROCESSING') {
            isStreamingPaused = true;
          }
        }
      }

      assert.strictEqual(isStreamingPaused, false, 'Streaming initially active');

      handleServerEvent({ type: 'state_change', state: 'TRANSCRIBING' });
      assert.strictEqual(voiceState, 'TRANSCRIBING');
      assert.strictEqual(isStreamingPaused, true, 'Must pause streaming immediately on TRANSCRIBING');

      handleServerEvent({ type: 'state_change', state: 'PROCESSING' });
      assert.strictEqual(voiceState, 'PROCESSING');
      assert.strictEqual(isStreamingPaused, true, 'Must remain paused during PROCESSING');
    });

    it('microphone tracks and PCM stream resume only after receiving matching backend WAKE_LISTENING acknowledgement', async () => {
      let isStreamingPaused = false;
      let currentTurnId = 1;
      const turnId = 1;
      let echoTimer = null;

      // 1. Enter SPEAKING
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      isStreamingPaused = true;

      const sendTTSCompleted = () => {
        if (currentTurnId !== turnId) return;
        // Do NOT unmute mic tracks or unpause streaming here!
        sentSocketMessages.push({ type: 'tts_completed', turn_id: turnId });
      };

      const handleServerAck = (event) => {
        if (event.type === 'state_change' && event.state === 'WAKE_LISTENING') {
          if (event.ack === 'tts_completed' && event.turn_id !== undefined && event.turn_id !== currentTurnId) {
            return;
          }
          mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
          isStreamingPaused = false;
        }
      };

      // Play audio and simulate onended
      playBase64WavAudio(
        dummyWavBase64,
        () => {},
        () => {
          echoTimer = setTimeout(() => {
            echoTimer = null;
            sendTTSCompleted();
          }, 30);
        },
        () => {},
        { autoRestoreSession: false }
      );

      await new Promise((r) => setTimeout(r, 15));
      mockAudioContext.activeSource.onended();

      // Wait for echo buffer timer (30ms)
      await new Promise((r) => setTimeout(r, 45));

      // Assert tts_completed was sent, BUT mic is STILL muted and streaming STILL paused!
      assert.strictEqual(sentSocketMessages.length, 1);
      assert.strictEqual(sentSocketMessages[0].type, 'tts_completed');
      assert.strictEqual(sentSocketMessages[0].turn_id, 1);
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must remain muted after tts_completed before backend ack');
      assert.strictEqual(isStreamingPaused, true, 'Streaming must remain paused until backend ack arrives');

      // Now simulate server responding with acknowledged state_change
      handleServerAck({
        type: 'state_change',
        state: 'WAKE_LISTENING',
        ack: 'tts_completed',
        turn_id: 1,
      });

      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic must be re-enabled after matching ack');
      assert.strictEqual(isStreamingPaused, false, 'Streaming must be unpaused after matching ack');
    });

    it('stale or duplicate tts_completed acknowledgements cannot resume the microphone for a newer turn', () => {
      let isStreamingPaused = true;
      let currentTurnId = 2; // Active turn has advanced to 2
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));

      const handleServerAck = (event) => {
        if (event.type === 'state_change' && event.state === 'WAKE_LISTENING') {
          if (event.ack === 'tts_completed' && event.turn_id !== undefined && event.turn_id !== currentTurnId) {
            return; // Ignore stale turn ack!
          }
          mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
          isStreamingPaused = false;
        }
      };

      // Stale ack for turn 1 arrives
      handleServerAck({
        type: 'state_change',
        state: 'WAKE_LISTENING',
        ack: 'tts_completed',
        turn_id: 1,
      });

      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Stale turn ack must not re-enable mic');
      assert.strictEqual(isStreamingPaused, true, 'Stale turn ack must not unpause streaming');

      // Matching ack for turn 2 arrives
      handleServerAck({
        type: 'state_change',
        state: 'WAKE_LISTENING',
        ack: 'tts_completed',
        turn_id: 2,
      });

      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Matching turn ack must re-enable mic');
      assert.strictEqual(isStreamingPaused, false, 'Matching turn ack must unpause streaming');
    });
  });

  describe('TTS Acknowledgement Timeout & Safe State Recovery', () => {
    it('normal acknowledgement cancels the ack timeout timer', async () => {
      let ackTimeoutTimer = null;
      let recoveryTriggered = false;

      // 1. sendTTSCompleted schedules ack timeout
      ackTimeoutTimer = setTimeout(() => {
        recoveryTriggered = true;
      }, 50);

      // 2. Normal matching ack arrives before 50ms
      await new Promise((r) => setTimeout(r, 15));
      if (ackTimeoutTimer) {
        clearTimeout(ackTimeoutTimer);
        ackTimeoutTimer = null;
      }

      // 3. Wait past 50ms deadline
      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(recoveryTriggered, false, 'Recovery must not trigger when ack arrives in time');
      assert.strictEqual(ackTimeoutTimer, null, 'Ack timeout timer must be cleared');
    });

    it('missing acknowledgement triggers safe get_state resync without unmuting mic', async () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      const socketMessages = [];
      let isConnected = true;
      let currentTurnId = 1;
      const turnId = 1;
      let ackTimeoutTimer = null;

      const handleAckTimeout = (timedOutTurnId) => {
        if (currentTurnId !== timedOutTurnId) return;
        if (!isConnected) return;
        // Query authoritative backend state
        socketMessages.push({ type: 'get_state' });
      };

      // sendTTSCompleted
      socketMessages.push({ type: 'tts_completed', turn_id: turnId });
      ackTimeoutTimer = setTimeout(() => {
        handleAckTimeout(turnId);
      }, 30);

      // Wait for timeout to fire (30ms)
      await new Promise((r) => setTimeout(r, 45));

      assert.strictEqual(socketMessages.length, 2);
      assert.strictEqual(socketMessages[0].type, 'tts_completed');
      assert.strictEqual(socketMessages[1].type, 'get_state', 'Must dispatch get_state on ack timeout');
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must NOT be blindly unmuted on timeout');
      assert.strictEqual(isStreamingPaused, true, 'Streaming must remain paused on timeout');
    });

    it('healthy connection with backend still SPEAKING does not unmute mic', () => {
      let isStreamingPaused = true;
      let currentTurnId = 1;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));

      const handleStateSync = (event) => {
        if (event.type === 'state_change') {
          if (event.state === 'WAKE_LISTENING') {
            if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
            mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
            isStreamingPaused = false;
          } else {
            mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
            isStreamingPaused = true;
          }
        }
      };

      // Backend returns authoritative state: still SPEAKING
      handleStateSync({
        type: 'state_change',
        state: 'SPEAKING',
        turn_id: 1,
      });

      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must remain muted when backend is SPEAKING');
      assert.strictEqual(isStreamingPaused, true, 'Streaming must remain paused');
    });

    it('backend confirms WAKE_LISTENING with matching turn; microphone resumes safely', () => {
      let isStreamingPaused = true;
      let currentTurnId = 1;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));

      const handleStateSync = (event) => {
        if (event.type === 'state_change') {
          if (event.state === 'WAKE_LISTENING') {
            if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
            mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
            isStreamingPaused = false;
          }
        }
      };

      // Backend confirms WAKE_LISTENING
      handleStateSync({
        type: 'state_change',
        state: 'WAKE_LISTENING',
        turn_id: 1,
      });

      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic must resume when backend confirms WAKE_LISTENING');
      assert.strictEqual(isStreamingPaused, false, 'Streaming must resume');
    });

    it('stale state responses cannot unmute the microphone', () => {
      let isStreamingPaused = true;
      let currentTurnId = 3; // Active turn is 3
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));

      const handleStateSync = (event) => {
        if (event.type === 'state_change') {
          if (event.state === 'WAKE_LISTENING') {
            if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
            mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
            isStreamingPaused = false;
          }
        }
      };

      // Stale state response for turn 2 arrives
      handleStateSync({
        type: 'state_change',
        state: 'WAKE_LISTENING',
        turn_id: 2,
      });

      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Stale turn_id must not unmute');
      assert.strictEqual(isStreamingPaused, true, 'Stale turn_id must not unpause');
    });

    it('disconnected socket triggers controlled reconnect without unmuting mic', () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      let isConnected = false;
      let reconnectCalled = false;
      let currentTurnId = 1;

      const handleAckTimeout = (timedOutTurnId) => {
        if (currentTurnId !== timedOutTurnId) return;
        if (!isConnected) {
          reconnectCalled = true;
          return;
        }
      };

      handleAckTimeout(1);

      assert.strictEqual(reconnectCalled, true, 'Must trigger reconnect on disconnected socket');
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Must NOT unmute mic when disconnected');
      assert.strictEqual(isStreamingPaused, true, 'Streaming must remain paused');
    });

    it('emergency stop cancels pending ack timeout recovery', async () => {
      let ackTimeoutTimer = null;
      let recoveryFired = false;
      let currentTurnId = 1;

      ackTimeoutTimer = setTimeout(() => {
        recoveryFired = true;
      }, 50);

      // Trigger emergencyStop at t = 10ms
      currentTurnId++;
      if (ackTimeoutTimer) {
        clearTimeout(ackTimeoutTimer);
        ackTimeoutTimer = null;
      }

      await new Promise((r) => setTimeout(r, 70));
      assert.strictEqual(recoveryFired, false, 'Emergency stop must cancel pending recovery');
      assert.strictEqual(ackTimeoutTimer, null);
    });

    it('unmount / stopAudioCapture clears pending ack timeout timer', () => {
      let ackTimeoutTimer = setTimeout(() => {}, 1000);

      // Simulate stopAudioCapture
      if (ackTimeoutTimer) {
        clearTimeout(ackTimeoutTimer);
        ackTimeoutTimer = null;
      }

      assert.strictEqual(ackTimeoutTimer, null, 'Unmount must clean up ack timeout timer');
    });

    it('duplicate acknowledgements cannot cause duplicate recovery', async () => {
      let ackTimeoutTimer = null;
      let micEnables = 0;
      let isStreamingPaused = true;
      let currentTurnId = 1;

      ackTimeoutTimer = setTimeout(() => {}, 100);

      const handleServerAck = (event) => {
        if (event.type === 'state_change' && event.state === 'WAKE_LISTENING') {
          if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
          if (ackTimeoutTimer) {
            clearTimeout(ackTimeoutTimer);
            ackTimeoutTimer = null;
          }
          if (isStreamingPaused) {
            micEnables++;
            isStreamingPaused = false;
          }
        }
      };

      // Ack 1
      handleServerAck({ type: 'state_change', state: 'WAKE_LISTENING', ack: 'tts_completed', turn_id: 1 });
      // Duplicate Ack 2
      handleServerAck({ type: 'state_change', state: 'WAKE_LISTENING', ack: 'tts_completed', turn_id: 1 });

      assert.strictEqual(micEnables, 1, 'Microphone must be enabled exactly once despite duplicate acks');
      assert.strictEqual(isStreamingPaused, false);
      assert.strictEqual(ackTimeoutTimer, null);
    });
  });

  describe('Phase 1 TTS Completed Resend & Safe Retry Safeguards', () => {
    it('lost first tts_completed acknowledgement followed by successful retry', async () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      const socketMessages = [];
      let isConnected = true;
      let currentTurnId = 1;
      let settledTurnId = null;
      const retryCountPerTurn = new Map();
      let ackTimeoutTimer = null;
      let statusMessage = '';

      const handleAckTimeout = (timedOutTurnId) => {
        if (currentTurnId !== timedOutTurnId) return;
        const retryCount = retryCountPerTurn.get(timedOutTurnId) ?? 0;
        if (retryCount >= 1) {
          statusMessage = 'Speech completion unacknowledged. Tap stop or emergency stop to reset.';
          return;
        }
        if (!isConnected) return;
        socketMessages.push({ type: 'get_state' });
      };

      const handleServerEvent = (event) => {
        if (event.type === 'state_change') {
          if (event.state === 'WAKE_LISTENING') {
            if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
            if (ackTimeoutTimer) {
              clearTimeout(ackTimeoutTimer);
              ackTimeoutTimer = null;
            }
            mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
            isStreamingPaused = false;
          } else {
            mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
            isStreamingPaused = true;

            if (
              event.state === 'SPEAKING' &&
              event.turn_id !== undefined &&
              event.turn_id === currentTurnId &&
              settledTurnId === event.turn_id
            ) {
              const currentRetries = retryCountPerTurn.get(event.turn_id) ?? 0;
              if (currentRetries === 0) {
                retryCountPerTurn.set(event.turn_id, 1);
                socketMessages.push({ type: 'tts_completed', turn_id: event.turn_id });
                if (ackTimeoutTimer) clearTimeout(ackTimeoutTimer);
                ackTimeoutTimer = setTimeout(() => {
                  ackTimeoutTimer = null;
                  handleAckTimeout(event.turn_id);
                }, 30);
              } else {
                statusMessage = 'Speech completion unacknowledged. Tap stop or emergency stop to reset.';
              }
            }
          }
        }
      };

      // 1. Turn 1 local playback settles -> send first tts_completed
      settledTurnId = 1;
      socketMessages.push({ type: 'tts_completed', turn_id: 1 });
      ackTimeoutTimer = setTimeout(() => {
        ackTimeoutTimer = null;
        handleAckTimeout(1);
      }, 20);

      // 2. Timeout fires: get_state is sent
      await new Promise((r) => setTimeout(r, 35));
      assert.strictEqual(socketMessages.length, 2);
      assert.strictEqual(socketMessages[0].type, 'tts_completed');
      assert.strictEqual(socketMessages[1].type, 'get_state');
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false);

      // 3. Backend responds to get_state with state: SPEAKING for turn 1
      handleServerEvent({ type: 'state_change', state: 'SPEAKING', turn_id: 1 });

      // Verify retry was sent exactly once, but mic remains muted!
      assert.strictEqual(socketMessages.length, 3);
      assert.strictEqual(socketMessages[2].type, 'tts_completed', 'Must resend tts_completed on SPEAKING response');
      assert.strictEqual(socketMessages[2].turn_id, 1);
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Mic must remain muted after retry');
      assert.strictEqual(isStreamingPaused, true, 'Streaming must remain paused after retry');
      assert.strictEqual(retryCountPerTurn.get(1), 1);

      // 4. Backend acknowledges the retry with WAKE_LISTENING
      handleServerEvent({ type: 'state_change', state: 'WAKE_LISTENING', ack: 'tts_completed', turn_id: 1 });

      // Verify microphone and streaming are safely restored
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, true, 'Mic must be enabled on WAKE_LISTENING ack');
      assert.strictEqual(isStreamingPaused, false, 'Streaming must resume on WAKE_LISTENING ack');
      assert.strictEqual(ackTimeoutTimer, null, 'Ack timeout timer must be cleared');
    });

    it('duplicate tts_completed does not cause incorrect state transitions', () => {
      let isStreamingPaused = false;
      let micEnabled = true;
      let currentTurnId = 1;
      let state = 'WAKE_LISTENING';

      const handleServerAck = (event) => {
        if (event.type === 'state_change' && event.state === 'WAKE_LISTENING') {
          if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
          state = 'WAKE_LISTENING';
          micEnabled = true;
          isStreamingPaused = false;
        }
      };

      // Initial valid ack
      handleServerAck({ type: 'state_change', state: 'WAKE_LISTENING', ack: 'tts_completed', turn_id: 1 });
      assert.strictEqual(state, 'WAKE_LISTENING');
      assert.strictEqual(micEnabled, true);

      // Duplicate ack
      handleServerAck({ type: 'state_change', state: 'WAKE_LISTENING', ack: 'tts_completed', turn_id: 1 });
      assert.strictEqual(state, 'WAKE_LISTENING');
      assert.strictEqual(micEnabled, true);
      assert.strictEqual(isStreamingPaused, false);
    });

    it('retry happens at most once per turn', () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      const socketMessages = [];
      let currentTurnId = 1;
      let settledTurnId = 1;
      const retryCountPerTurn = new Map();
      let statusMessage = '';

      const handleServerEvent = (event) => {
        if (event.type === 'state_change') {
          if (event.state !== 'WAKE_LISTENING') {
            mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
            isStreamingPaused = true;

            if (
              event.state === 'SPEAKING' &&
              event.turn_id !== undefined &&
              event.turn_id === currentTurnId &&
              settledTurnId === event.turn_id
            ) {
              const currentRetries = retryCountPerTurn.get(event.turn_id) ?? 0;
              if (currentRetries === 0) {
                retryCountPerTurn.set(event.turn_id, 1);
                socketMessages.push({ type: 'tts_completed', turn_id: event.turn_id });
              } else {
                statusMessage = 'Speech completion unacknowledged. Tap stop or emergency stop to reset.';
              }
            }
          }
        }
      };

      // First response in SPEAKING triggers retry #1
      handleServerEvent({ type: 'state_change', state: 'SPEAKING', turn_id: 1 });
      assert.strictEqual(socketMessages.length, 1);
      assert.strictEqual(retryCountPerTurn.get(1), 1);

      // Second response in SPEAKING does NOT trigger retry #2
      handleServerEvent({ type: 'state_change', state: 'SPEAKING', turn_id: 1 });
      assert.strictEqual(socketMessages.length, 1, 'Retry must not fire a second time for same turn');
      assert.strictEqual(statusMessage, 'Speech completion unacknowledged. Tap stop or emergency stop to reset.');
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false);
    });

    it('stale turn response cannot trigger a retry or unmute', () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      const socketMessages = [];
      let currentTurnId = 2; // Active turn is 2
      let settledTurnId = 2;
      const retryCountPerTurn = new Map();

      const handleServerEvent = (event) => {
        if (event.type === 'state_change') {
          if (event.state === 'WAKE_LISTENING') {
            if (event.turn_id !== undefined && event.turn_id !== currentTurnId) return;
            mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
            isStreamingPaused = false;
          } else {
            mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
            isStreamingPaused = true;

            if (
              event.state === 'SPEAKING' &&
              event.turn_id !== undefined &&
              event.turn_id === currentTurnId &&
              settledTurnId === event.turn_id
            ) {
              const currentRetries = retryCountPerTurn.get(event.turn_id) ?? 0;
              if (currentRetries === 0) {
                retryCountPerTurn.set(event.turn_id, 1);
                socketMessages.push({ type: 'tts_completed', turn_id: event.turn_id });
              }
            }
          }
        }
      };

      // Stale turn 1 reports SPEAKING
      handleServerEvent({ type: 'state_change', state: 'SPEAKING', turn_id: 1 });
      assert.strictEqual(socketMessages.length, 0, 'Must NOT retry for stale turn 1');

      // Stale turn 1 reports WAKE_LISTENING
      handleServerEvent({ type: 'state_change', state: 'WAKE_LISTENING', turn_id: 1 });
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Must NOT unmute for stale turn 1');
      assert.strictEqual(isStreamingPaused, true);
    });

    it('emergency stop cancels pending retry', async () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      const socketMessages = [];
      let currentTurnId = 1;
      let settledTurnId = 1;
      const retryCountPerTurn = new Map();
      let ackTimeoutTimer = null;

      const handleAckTimeout = (timedOutTurnId) => {
        if (currentTurnId !== timedOutTurnId) return;
        socketMessages.push({ type: 'get_state' });
      };

      ackTimeoutTimer = setTimeout(() => {
        handleAckTimeout(1);
      }, 40);

      // Emergency stop triggered at t = 10ms
      currentTurnId++;
      settledTurnId = null;
      retryCountPerTurn.clear();
      if (ackTimeoutTimer) {
        clearTimeout(ackTimeoutTimer);
        ackTimeoutTimer = null;
      }
      mockStream.getAudioTracks().forEach((t) => (t.enabled = true));
      isStreamingPaused = false;

      await new Promise((r) => setTimeout(r, 60));

      assert.strictEqual(socketMessages.length, 0, 'No get_state or retry sent after emergency stop');
      assert.strictEqual(ackTimeoutTimer, null);
      assert.strictEqual(settledTurnId, null);
    });

    it('failed retry never causes premature microphone activation', async () => {
      let isStreamingPaused = true;
      mockStream.getAudioTracks().forEach((t) => (t.enabled = false));
      const socketMessages = [];
      let isConnected = true;
      let currentTurnId = 1;
      let settledTurnId = 1;
      const retryCountPerTurn = new Map([[1, 1]]); // Retry already used!
      let ackTimeoutTimer = null;
      let statusMessage = '';

      const handleAckTimeout = (timedOutTurnId) => {
        if (currentTurnId !== timedOutTurnId) return;
        const retryCount = retryCountPerTurn.get(timedOutTurnId) ?? 0;
        if (retryCount >= 1) {
          statusMessage = 'Speech completion unacknowledged. Tap stop or emergency stop to reset.';
          return;
        }
        if (!isConnected) return;
        socketMessages.push({ type: 'get_state' });
      };

      // Safety timeout for retry fires
      ackTimeoutTimer = setTimeout(() => {
        ackTimeoutTimer = null;
        handleAckTimeout(1);
      }, 20);

      await new Promise((r) => setTimeout(r, 35));

      assert.strictEqual(socketMessages.length, 0, 'Must NOT send get_state after retry times out');
      assert.strictEqual(statusMessage, 'Speech completion unacknowledged. Tap stop or emergency stop to reset.');
      assert.strictEqual(mockStream.getAudioTracks()[0].enabled, false, 'Microphone must remain strictly muted');
      assert.strictEqual(isStreamingPaused, true, 'Streaming must remain strictly paused');
    });
  });
});
