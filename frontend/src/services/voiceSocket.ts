/**
 * Centralized WebSocket client for Jarvis Voice Assistant.
 * Manages streaming PCM audio and bidirectional JSON control events.
 */

import type { VoiceClientMessage, VoiceServerEvent } from '../types/voice';

export type VoiceEventHandler = (event: VoiceServerEvent) => void;
export type VoiceConnectionHandler = (isConnected: boolean) => void;

export class VoiceSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private isExplicitlyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private eventHandlers: Set<VoiceEventHandler> = new Set();
  private connectionHandlers: Set<VoiceConnectionHandler> = new Set();

  constructor(customUrl?: string) {
    if (customUrl) {
      this.url = customUrl;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${protocol}//${window.location.host}/api/ws/voice`;
    }
  }

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isExplicitlyClosed = false;

    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
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

      this.ws.onclose = () => {
        this.notifyConnectionState(false);
        this.ws = null;
        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.error('[VoiceSocket] WebSocket error:', err);
      };
    } catch (err) {
      console.error('[VoiceSocket] Connection error:', err);
      this.notifyConnectionState(false);
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
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

