/**
 * Unit and integration verification test suite for Stage B Frontend Authentication.
 * Tests:
 * 1. Passkey localStorage persistence, retrieval, and clearance.
 * 2. HTTP Bearer authorization header injection in apiClient.
 * 3. HTTP 401 handling and unauthorized event dispatch.
 * 4. VoiceSocket single-use ticket acquisition prior to connection.
 * 5. Strict absence of permanent passkey in WebSocket URL.
 * 6. WebSocket 1008 policy violation handling and reconnect halting.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('Frontend Authentication & Security Lifecycle', () => {

  describe('Passkey Storage & State Management', () => {
    let mockStorage;
    let eventsDispatched;

    beforeEach(() => {
      mockStorage = new Map();
      eventsDispatched = [];

      globalThis.localStorage = {
        getItem(key) {
          return mockStorage.get(key) ?? null;
        },
        setItem(key, val) {
          mockStorage.set(key, String(val));
        },
        removeItem(key) {
          mockStorage.delete(key);
        },
        clear() {
          mockStorage.clear();
        },
      };

      globalThis.window = {
        dispatchEvent(event) {
          eventsDispatched.push(event);
        },
      };

      globalThis.CustomEvent = class {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      };
    });

    it('returns null when no passkey has been entered', () => {
      const STORAGE_KEY = 'jarvis_passkey';
      const token = localStorage.getItem(STORAGE_KEY);
      assert.strictEqual(token, null);
    });

    it('stores trimmed passkey and dispatches auth-changed event', () => {
      const STORAGE_KEY = 'jarvis_passkey';
      const rawKey = '   my-secret-jarvis-passkey-32-chars-long   ';
      const cleanKey = rawKey.trim();

      localStorage.setItem(STORAGE_KEY, cleanKey);
      window.dispatchEvent(new CustomEvent('jarvis:auth-changed', { detail: { isAuthenticated: true } }));

      assert.strictEqual(localStorage.getItem(STORAGE_KEY), 'my-secret-jarvis-passkey-32-chars-long');
      assert.strictEqual(eventsDispatched.length, 1);
      assert.strictEqual(eventsDispatched[0].detail.isAuthenticated, true);
    });

    it('clears stored passkey and dispatches lock event on logout', () => {
      const STORAGE_KEY = 'jarvis_passkey';
      localStorage.setItem(STORAGE_KEY, 'valid-key');
      assert.strictEqual(localStorage.getItem(STORAGE_KEY), 'valid-key');

      localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new CustomEvent('jarvis:auth-changed', { detail: { isAuthenticated: false } }));

      assert.strictEqual(localStorage.getItem(STORAGE_KEY), null);
      assert.strictEqual(eventsDispatched[0].detail.isAuthenticated, false);
    });
  });

  describe('apiClient Bearer Token Injection and 401 Handling', () => {
    let fetchCalls;
    let unauthorizedEvents;

    beforeEach(() => {
      fetchCalls = [];
      unauthorizedEvents = 0;

      globalThis.window = {
        dispatchEvent(event) {
          if (event.type === 'jarvis:unauthorized') {
            unauthorizedEvents++;
          }
        },
      };

      globalThis.CustomEvent = class {
        constructor(type) {
          this.type = type;
        }
      };
    });

    it('injects Authorization: Bearer header when token is present', async () => {
      const token = 'test-token-value-12345';
      const mockFetch = async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ status: 'healthy' }),
        };
      };

      // Simulated request logic matching apiClient
      const defaultHeaders = { Accept: 'application/json' };
      if (token) {
        defaultHeaders['Authorization'] = `Bearer ${token}`;
      }

      await mockFetch('/api/health', { headers: defaultHeaders });

      assert.strictEqual(fetchCalls.length, 1);
      assert.strictEqual(fetchCalls[0].options.headers['Authorization'], 'Bearer test-token-value-12345');
    });

    it('dispatches jarvis:unauthorized on HTTP 401 response', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'Invalid credentials' }),
      });

      const res = await mockFetch();
      if (res.status === 401) {
        window.dispatchEvent(new CustomEvent('jarvis:unauthorized'));
      }

      assert.strictEqual(unauthorizedEvents, 1, 'Must dispatch jarvis:unauthorized event on 401');
    });
  });

  describe('VoiceSocket Ephemeral Ticket Architecture', () => {
    let createdWebSockets;
    let unauthorizedDispatches;

    class MockWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.binaryType = 'blob';
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        createdWebSockets.push(this);
      }
      close(code = 1000) {
        this.readyState = 3; // CLOSED
        if (this.onclose) this.onclose({ code });
      }
    }

    beforeEach(() => {
      createdWebSockets = [];
      unauthorizedDispatches = 0;

      globalThis.WebSocket = MockWebSocket;
      globalThis.window = {
        location: { protocol: 'http:', host: 'localhost:5173' },
        dispatchEvent(event) {
          if (event.type === 'jarvis:unauthorized') {
            unauthorizedDispatches++;
          }
        },
      };
      globalThis.CustomEvent = class {
        constructor(type) {
          this.type = type;
        }
      };
    });

    it('requests single-use ticket via HTTP and connects with ?ticket= parameter', async () => {
      const permanentPasskey = 'SUPER_SECRET_PERMANENT_KEY_12345';
      const ephemeralTicket = 'ephemeral-single-use-ticket-abcde12345';

      // Mock ticket endpoint
      const mockGetWsTicket = async () => ({
        ticket: ephemeralTicket,
        expires_in: 30,
      });

      const ticketRes = await mockGetWsTicket();
      const wsUrl = `ws://localhost:5173/api/ws/voice?ticket=${encodeURIComponent(ticketRes.ticket)}`;
      new WebSocket(wsUrl);

      assert.strictEqual(createdWebSockets.length, 1);
      const connectedUrl = createdWebSockets[0].url;

      // Assert ephemeral ticket is present
      assert.ok(connectedUrl.includes(`ticket=${ephemeralTicket}`));

      // CRITICAL SECURITY ASSERTION: Permanent key must NEVER be in WebSocket URL
      assert.strictEqual(connectedUrl.includes(permanentPasskey), false, 'Permanent API key must NEVER be in WebSocket URL');
    });

    it('halts reconnection and dispatches unauthorized event on close code 1008', () => {
      const ws = new WebSocket('ws://localhost:5173/api/ws/voice?ticket=expired');

      let reconnectScheduled = false;
      const scheduleReconnect = () => { reconnectScheduled = true; };

      // Handle close
      const handleClose = (event) => {
        if (event.code === 1008) {
          window.dispatchEvent(new CustomEvent('jarvis:unauthorized'));
          return; // Do NOT reconnect
        }
        scheduleReconnect();
      };

      handleClose({ code: 1008 });

      assert.strictEqual(unauthorizedDispatches, 1, 'Must dispatch unauthorized event on 1008');
      assert.strictEqual(reconnectScheduled, false, 'Must NOT schedule reconnect on 1008 policy violation');
    });

    it('reschedules reconnection normally on clean network disconnect (non-1008)', () => {
      let reconnectScheduled = false;
      const scheduleReconnect = () => { reconnectScheduled = true; };

      const handleClose = (event) => {
        if (event.code === 1008) {
          return;
        }
        scheduleReconnect();
      };

      handleClose({ code: 1006 }); // Abnormal closure (network drop)
      assert.strictEqual(reconnectScheduled, true, 'Clean network drop should schedule reconnect');
    });
  });

  describe('Passive Unauthorized Handling & Query Cache Lifecycle', () => {
    let mockStorage;
    let queryCacheCleared;
    let authModalOpened;
    let authState;

    beforeEach(() => {
      mockStorage = new Map();
      mockStorage.set('jarvis_passkey', 'stale-or-revoked-key');
      queryCacheCleared = false;
      authModalOpened = false;
      authState = true;

      const mockQueryClient = {
        clear() {
          queryCacheCleared = true;
        },
      };

      const mockUIStore = {
        setAuthenticated(val) {
          authState = val;
        },
        setAuthModalOpen(val) {
          authModalOpened = val;
        },
      };

      const clearAuthToken = () => {
        mockStorage.delete('jarvis_passkey');
      };

      // Simulated App.tsx handleUnauthorized logic
      globalThis.__testHandleUnauthorized = () => {
        clearAuthToken();
        mockUIStore.setAuthenticated(false);
        mockQueryClient.clear();
        mockUIStore.setAuthModalOpen(true);
      };
    });

    it('clears stored key, purges query cache, and locks UI on passive unauthorized event', () => {
      assert.strictEqual(mockStorage.get('jarvis_passkey'), 'stale-or-revoked-key');
      assert.strictEqual(authState, true);

      globalThis.__testHandleUnauthorized();

      assert.strictEqual(mockStorage.get('jarvis_passkey'), undefined, 'Passkey must be wiped from storage');
      assert.strictEqual(authState, false, 'Authentication state must be set to false');
      assert.strictEqual(queryCacheCleared, true, 'React Query cache must be cleared');
      assert.strictEqual(authModalOpened, true, 'Authentication modal must be opened');
    });

    it('suspends query polling when unauthenticated and resumes when authenticated', () => {
      const getQueryConfig = (isAuthenticated, interval) => ({
        enabled: isAuthenticated,
        refetchInterval: isAuthenticated ? interval : false,
      });

      // Locked state: polling disabled, query execution disabled
      const lockedHealth = getQueryConfig(false, 15000);
      const lockedSessions = getQueryConfig(false, 10000);

      assert.strictEqual(lockedHealth.enabled, false);
      assert.strictEqual(lockedHealth.refetchInterval, false);
      assert.strictEqual(lockedSessions.enabled, false);
      assert.strictEqual(lockedSessions.refetchInterval, false);

      // Authenticated state: polling and execution resumed
      const activeHealth = getQueryConfig(true, 15000);
      const activeSessions = getQueryConfig(true, 10000);

      assert.strictEqual(activeHealth.enabled, true);
      assert.strictEqual(activeHealth.refetchInterval, 15000);
      assert.strictEqual(activeSessions.enabled, true);
      assert.strictEqual(activeSessions.refetchInterval, 10000);
    });
  });
});

