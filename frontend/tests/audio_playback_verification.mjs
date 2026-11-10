/**
 * Verification test suite for Kokoro Web Audio playback utility (Milestone 2, Step 1).
 * Tests against:
 * 1. Base64 WAV decoding and ArrayBuffer extraction.
 * 2. Invalid, empty, or malformed Base64 payload rejection.
 * 3. Web Audio decoding, autoplay resume, and playback dispatch.
 * 4. Cancellation and stop operations (suppressing onEnd on manual abort).
 * 5. Sequential replacement (new playback cleanly stops previous playback).
 * 6. AudioContext unavailable and decode failure fallback handling.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToArrayBuffer,
  getPlaybackAudioContext,
  playBase64WavAudio,
  stopAudioPlayback,
  isAudioPlaying,
  setPlaybackAudioContextForTesting,
} from '../src/utils/audioPlayback.ts';

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
    this.resumeShouldReject = options.resumeShouldReject || false;
    this.resumed = false;
    this.activeSource = null;
  }

  async resume() {
    this.resumed = true;
    if (this.resumeShouldReject) {
      throw new Error('NotAllowedError: The play() request was interrupted by a call to pause().');
    }
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

describe('Kokoro Web Audio Playback Utility', () => {
  const dummyValidWavBase64 = Buffer.from('RIFF1234WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00').toString('base64');

  beforeEach(() => {
    stopAudioPlayback();
    setPlaybackAudioContextForTesting(null);
  });

  describe('Base64 Decoding & Validation', () => {
    it('decodes valid Base64 string into ArrayBuffer correctly', () => {
      const original = 'RIFFTestWAV';
      const b64 = Buffer.from(original).toString('base64');
      const arrayBuffer = base64ToArrayBuffer(b64);

      assert.ok(arrayBuffer instanceof ArrayBuffer, 'Must return an ArrayBuffer instance');
      const decodedText = Buffer.from(arrayBuffer).toString();
      assert.strictEqual(decodedText, original, 'Decoded bytes must match original content');
    });

    it('rejects empty or whitespace-only Base64 strings', () => {
      assert.throws(
        () => base64ToArrayBuffer(''),
        /Base64 input must be a non-empty string/,
        'Should reject empty string'
      );
      assert.throws(
        () => base64ToArrayBuffer('   '),
        /Base64 input must be a non-empty string/,
        'Should reject whitespace-only string'
      );
    });

    it('rejects malformed Base64 strings with invalid length or characters', () => {
      assert.throws(
        () => base64ToArrayBuffer('abc'), // Length 3 (not modulo 4)
        /Invalid Base64 string format/,
        'Should reject invalid length'
      );
      assert.throws(
        () => base64ToArrayBuffer('ab!@#$=='),
        /Invalid Base64 string format/,
        'Should reject invalid characters'
      );
    });
  });

  describe('Web Audio Decoding & Playback Lifecycle', () => {
    it('resumes suspended AudioContext and plays decoded audio buffer', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'suspended' });
      setPlaybackAudioContextForTesting(mockCtx);

      let started = false;
      let ended = false;

      playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; }
      );

      // Wait for async decode and schedule
      await new Promise((r) => setTimeout(r, 20));

      assert.strictEqual(started, true, 'onStart callback must be invoked');
      assert.strictEqual(mockCtx.resumed, true, 'Suspended AudioContext must be resumed');
      assert.ok(mockCtx.activeSource, 'AudioBufferSourceNode must be created');
      assert.strictEqual(mockCtx.activeSource.started, true, 'Source node must have started');
      assert.strictEqual(isAudioPlaying(), true, 'isAudioPlaying() must report true while playing');

      // Trigger natural playback end
      mockCtx.activeSource.onended();
      assert.strictEqual(ended, true, 'onEnd callback must be invoked when playback finishes naturally');
      assert.strictEqual(isAudioPlaying(), false, 'isAudioPlaying() must report false after playback ends');
    });

    it('stopAudioPlayback immediately stops active playback and suppresses onEnd', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      let started = false;
      let ended = false;

      const stop = playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; }
      );

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(started, true);
      assert.strictEqual(isAudioPlaying(), true);

      // Abort playback via stop() handle
      stop();

      assert.strictEqual(mockCtx.activeSource.stopped, true, 'Source must be stopped');
      assert.strictEqual(mockCtx.activeSource.disconnected, true, 'Source must be disconnected');
      assert.strictEqual(ended, false, 'onEnd must NOT be called when playback is aborted manually');
      assert.strictEqual(isAudioPlaying(), false, 'isAudioPlaying() must be false after stop');
    });

    it('starting a new playback cleanly stops previous in-flight playback', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      let firstStarted = false;
      let firstEnded = false;
      let secondStarted = false;
      let secondEnded = false;

      // Start first audio
      playBase64WavAudio(
        dummyValidWavBase64,
        () => { firstStarted = true; },
        () => { firstEnded = true; }
      );

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(firstStarted, true);
      const firstSource = mockCtx.activeSource;

      // Start second audio (must replace first)
      playBase64WavAudio(
        dummyValidWavBase64,
        () => { secondStarted = true; },
        () => { secondEnded = true; }
      );

      assert.strictEqual(firstSource.stopped, true, 'First source must be stopped upon replacement');
      assert.strictEqual(firstSource.disconnected, true, 'First source must be disconnected');
      assert.strictEqual(firstEnded, false, 'First onEnd must NOT be called upon replacement');

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(secondStarted, true, 'Second audio must start playing');
      assert.strictEqual(isAudioPlaying(), true);

      // Complete second audio naturally
      mockCtx.activeSource.onended();
      assert.strictEqual(secondEnded, true, 'Second onEnd must be called when finished');
      assert.strictEqual(isAudioPlaying(), false);
    });

    it('reports controlled onError when AudioContext.resume() fails and context remains suspended', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'suspended', resumeShouldReject: true });
      setPlaybackAudioContextForTesting(mockCtx);

      let started = false;
      let ended = false;
      let caughtError = null;

      playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; },
        (err) => { caughtError = err; }
      );

      await new Promise((r) => setTimeout(r, 20));

      assert.strictEqual(mockCtx.resumed, true, 'Resume was called');
      assert.strictEqual(started, false, 'Playback must not start if context remains suspended');
      assert.strictEqual(ended, false, 'onEnd must not be invoked on resume failure');
      assert.ok(caughtError instanceof Error, 'onError must receive a controlled Error instance');
      assert.match(caughtError.message, /AudioContext resume failed or blocked by autoplay policy/);
      assert.strictEqual(mockCtx.activeSource, null, 'No source node should be created or referenced');
      assert.strictEqual(isAudioPlaying(), false, 'isAudioPlaying() must remain false');
    });

    it('cancelling while decodeAudioData is in-flight suppresses node startup and callbacks', async () => {
      let resolveDecode;
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      mockCtx.decodeAudioData = () => new Promise((resolve) => {
        resolveDecode = resolve;
      });
      setPlaybackAudioContextForTesting(mockCtx);

      let started = false;
      let ended = false;

      const stop = playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; }
      );

      // Cancel immediately before decode resolves
      stop();

      // Now resolve decode
      resolveDecode({ length: 24000, duration: 1.0, sampleRate: 24000, numberOfChannels: 1 });
      await new Promise((r) => setTimeout(r, 20));

      assert.strictEqual(started, false, 'onStart must not be called when cancelled in-flight');
      assert.strictEqual(ended, false, 'onEnd must not be called when cancelled in-flight');
      assert.strictEqual(mockCtx.activeSource, null, 'No source node should have been created or started');
      assert.strictEqual(isAudioPlaying(), false);
    });

    it('prefixed webkitAudioContext fallback resolves properly when standard AudioContext is absent', () => {
      setPlaybackAudioContextForTesting(null);
      let webkitInstantiated = false;

      class MockWebkitAudioContext extends MockAudioContext {
        constructor() {
          super();
          webkitInstantiated = true;
        }
      }

      const originalWindow = globalThis.window;
      globalThis.window = {
        webkitAudioContext: MockWebkitAudioContext,
      };

      const ctx = getPlaybackAudioContext();

      globalThis.window = originalWindow;

      assert.ok(ctx, 'Should successfully create context from webkitAudioContext');
      assert.strictEqual(webkitInstantiated, true, 'webkitAudioContext constructor was called');
    });

    it('manages W3C AudioSession routing from play-and-record to playback and back on finish', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      Object.defineProperty(globalThis.navigator, 'audioSession', {
        value: { type: 'play-and-record' },
        configurable: true,
        writable: true,
      });

      let started = false;
      let ended = false;

      playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; }
      );

      assert.strictEqual(globalThis.navigator.audioSession.type, 'playback', 'Should route to playback upon start');

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(started, true);

      // Trigger natural end
      mockCtx.activeSource.onended();
      assert.strictEqual(ended, true);
      assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record', 'Should restore to play-and-record upon finish');

      delete globalThis.navigator.audioSession;
    });

    it('leaves AudioSession in playback on natural finish when autoRestoreSession is false', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      Object.defineProperty(globalThis.navigator, 'audioSession', {
        value: { type: 'play-and-record' },
        configurable: true,
        writable: true,
      });

      let started = false;
      let ended = false;

      playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; },
        undefined,
        { autoRestoreSession: false }
      );

      assert.strictEqual(globalThis.navigator.audioSession.type, 'playback', 'Should route to playback upon start');

      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(started, true);

      // Trigger natural end
      mockCtx.activeSource.onended();
      assert.strictEqual(ended, true);
      assert.strictEqual(globalThis.navigator.audioSession.type, 'playback', 'Must remain in playback when autoRestoreSession is false');

      delete globalThis.navigator.audioSession;
    });

    it('restores AudioSession to play-and-record upon manual cancellation', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      Object.defineProperty(globalThis.navigator, 'audioSession', {
        value: { type: 'play-and-record' },
        configurable: true,
        writable: true,
      });

      const stop = playBase64WavAudio(dummyValidWavBase64);
      assert.strictEqual(globalThis.navigator.audioSession.type, 'playback');

      await new Promise((r) => setTimeout(r, 20));

      stop();
      assert.strictEqual(globalThis.navigator.audioSession.type, 'play-and-record', 'Should restore to play-and-record upon cancellation');

      delete globalThis.navigator.audioSession;
    });
  });

  describe('Error Handling & Fallback Resilience', () => {
    it('gracefully notifies onError when AudioContext is unavailable', () => {
      setPlaybackAudioContextForTesting(null);
      // Ensure global AudioContext is undefined in test
      const originalWindow = globalThis.window;
      globalThis.window = undefined;

      let caughtError = null;
      let ended = false;

      playBase64WavAudio(
        dummyValidWavBase64,
        undefined,
        () => { ended = true; },
        (err) => { caughtError = err; }
      );

      globalThis.window = originalWindow;

      assert.ok(caughtError instanceof Error, 'onError must be passed an Error instance');
      assert.match(caughtError.message, /AudioContext is unavailable/);
      assert.strictEqual(ended, false, 'onEnd must not fire on initialization error');
      assert.strictEqual(isAudioPlaying(), false);
    });

    it('handles corrupted audio data gracefully via onError', async () => {
      const mockCtx = new MockAudioContext({ decodeShouldFail: true });
      setPlaybackAudioContextForTesting(mockCtx);

      let started = false;
      let ended = false;
      let caughtError = null;

      playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => { ended = true; },
        (err) => { caughtError = err; }
      );

      await new Promise((r) => setTimeout(r, 20));

      assert.strictEqual(started, false, 'onStart must not be called when decode fails');
      assert.strictEqual(ended, false, 'onEnd must not be called when decode fails');
      assert.ok(caughtError instanceof Error, 'onError must receive the decode failure error');
      assert.match(caughtError.message, /Corrupted WAV audio format/);
      assert.strictEqual(isAudioPlaying(), false);
    });
  });

  describe('Playback Safety Watchdog & Settlement Guards', () => {
    it('watchdog fires and triggers safeEnd when source.onended is never invoked', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      let started = false;
      let ended = false;
      let endedCount = 0;

      playBase64WavAudio(
        dummyValidWavBase64,
        () => { started = true; },
        () => {
          ended = true;
          endedCount++;
        },
        () => {},
        { autoRestoreSession: false, watchdogDelayMs: 40 }
      );

      await new Promise((r) => setTimeout(r, 15));
      assert.strictEqual(started, true, 'Playback should have started');
      assert.strictEqual(ended, false, 'Playback should not have ended before watchdog delay');
      assert.strictEqual(isAudioPlaying(), true);

      // Do NOT call mockCtx.activeSource.onended() — simulate dropped browser callback
      // Wait for watchdog to trigger (40ms deadline)
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(ended, true, 'Watchdog must trigger safeEnd when onended is missing');
      assert.strictEqual(endedCount, 1, 'onEnd must fire exactly once');
      assert.strictEqual(mockCtx.activeSource.stopped, true, 'Watchdog must stop the source node');
      assert.strictEqual(isAudioPlaying(), false, 'Playing flag must be cleared');
    });

    it('watchdog is disarmed on natural source.onended completion without duplicate onEnd calls', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      let endedCount = 0;

      playBase64WavAudio(
        dummyValidWavBase64,
        undefined,
        () => { endedCount++; },
        undefined,
        { autoRestoreSession: false, watchdogDelayMs: 60 }
      );

      await new Promise((r) => setTimeout(r, 15));

      // Natural completion before watchdog
      mockCtx.activeSource.onended();
      assert.strictEqual(endedCount, 1, 'Natural completion fires onEnd once');

      // Wait beyond the 60ms watchdog deadline
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(endedCount, 1, 'Watchdog must be cancelled and not fire duplicate onEnd');
    });

    it('manual stopAudioPlayback disarms watchdog and suppresses onEnd', async () => {
      const mockCtx = new MockAudioContext({ initialState: 'running' });
      setPlaybackAudioContextForTesting(mockCtx);

      let ended = false;

      playBase64WavAudio(
        dummyValidWavBase64,
        undefined,
        () => { ended = true; },
        undefined,
        { autoRestoreSession: false, watchdogDelayMs: 40 }
      );

      await new Promise((r) => setTimeout(r, 15));

      // Explicit cancellation
      stopAudioPlayback();
      assert.strictEqual(ended, false, 'Manual stop must not trigger onEnd');
      assert.strictEqual(isAudioPlaying(), false);

      // Wait beyond watchdog deadline
      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(ended, false, 'Cancelled playback watchdog must not trigger onEnd');
    });
  });
});
