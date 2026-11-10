/**
 * Centralized WebSocket client for Jarvis Voice Assistant.
 * Manages streaming PCM audio and bidirectional JSON control events.
 * Authenticates via short-lived, single-use tickets issued by the backend.
 * Never passes or logs the permanent API passkey in WebSocket URLs.
 */

import type { VoiceClientMessage, VoiceServerEvent } from '../types/voice';
import { apiClient } from './apiClient';
import { isAuthenticated, UNAUTHORIZED_EVENT } from './auth';

export type VoiceEventHandler = (event: VoiceServerEvent) => void;
export type VoiceConnectionHandler = (isConnected: boolean) => void;

export class VoiceSocket {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private isExplicitlyClosed = false;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private eventHandlers: Set<VoiceEventHandler> = new Set();
  private connectionHandlers: Set<VoiceConnectionHandler> = new Set();

  constructor(customUrl?: string) {
    if (customUrl) {
      this.baseUrl = customUrl;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.baseUrl = `${protocol}//${window.location.host}/api/ws/voice`;
    }
  }

  public async connect(): Promise<void> {
    if (
      this.isConnecting ||
      (this.ws &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }

    this.isExplicitlyClosed = false;
    this.isConnecting = true;

    try {
      // 1. Request an ephemeral, single-use ticket via authenticated HTTP endpoint
      let ticket: string | null = null;
      try {
        const ticketRes = await apiClient.getWsTicket();
        ticket = ticketRes.ticket;
      } catch (authErr) {
        this.isConnecting = false;
        console.warn('[VoiceSocket] Failed to obtain WebSocket ticket (unauthorized or server unreachable)');
        this.notifyConnectionState(false);
        this.notifyEvent({
          type: 'error',
          message: 'Voice authorization required. Please verify your Jarvis passkey.',
        });
        return;
      }

      if (!ticket) {
        this.isConnecting = false;
        this.notifyConnectionState(false);
        return;
      }

      // 2. Establish connection using the single-use ticket.
      // NEVER append the permanent passkey to a WebSocket URL!
      const separator = this.baseUrl.includes('?') ? '&' : '?';
      const wsUrl = `${this.baseUrl}${separator}ticket=${encodeURIComponent(ticket)}`;

      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.notifyConnectionState(true);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          try {
            const parsed = JSON.parse(event.data) as VoiceServerEvent;
            this.notifyEvent(parsed);
          } catch (err) {
            console.error('[VoiceSocket] Failed to parse server message:', err);
          }
        }
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.isConnecting = false;
        this.notifyConnectionState(false);
        this.ws = null;

        // Policy violation 1008 indicates ticket rejected or expired.
        // Halt reconnection to prevent infinite retry loops.
        if (event.code === 1008) {
          console.warn('[VoiceSocket] Connection rejected with 1008 Policy Violation (Unauthorized)');
          this.notifyEvent({
            type: 'error',
            message: 'Voice connection rejected by security policy. Passkey required.',
          });
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
          }
          return;
        }

        if (!this.isExplicitlyClosed && isAuthenticated()) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        this.isConnecting = false;
        console.error('[VoiceSocket] WebSocket error occurred:', err);
      };
    } catch (err) {
      this.isConnecting = false;
      console.error('[VoiceSocket] Connection setup error:', err);
      this.notifyConnectionState(false);
      if (!this.isExplicitlyClosed && isAuthenticated()) {
        this.scheduleReconnect();
      }
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.isConnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.notifyConnectionState(false);
  }

  public reconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  public sendAudio(pcmData: Int16Array | ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcmData);
    }
  }

  public sendMessage(msg: VoiceClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public addEventListener(handler: VoiceEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  public addConnectionListener(handler: VoiceConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (!isAuthenticated()) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[VoiceSocket] Max reconnection attempts reached.');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 8000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private notifyEvent(event: VoiceServerEvent): void {
    this.eventHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (err) {
        console.error('[VoiceSocket] Handler exception:', err);
      }
    });
  }

  private notifyConnectionState(isConnected: boolean): void {
    this.connectionHandlers.forEach((handler) => {
      try {
        handler(isConnected);
      } catch (err) {
        console.error('[VoiceSocket] Connection handler exception:', err);
      }
    });
  }
}

