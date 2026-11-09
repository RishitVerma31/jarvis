import type {
  ChatRequest,
  ChatResponse,
  HealthResponse,
  SessionDetailResponse,
  SessionSummary,
} from '../types/api';

/**
 * Standard application API error.
 */
export class ApiError extends Error {
  public status?: number;
  public details?: unknown;

  constructor(message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Generic JSON request wrapper using the Vite /api reverse proxy.
 */
async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  // Always prefix with /api so Vite proxy intercepts and forwards to backend
  const url = endpoint.startsWith('/') ? `/api${endpoint}` : `/api/${endpoint}`;

  const defaultHeaders: HeadersInit = {
    'Accept': 'application/json',
  };

  if (options.body && typeof options.body === 'string') {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  // 15 second request timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
      signal: options.signal || controller.signal,
    });

    clearTimeout(timeoutId);

    // Parse JSON payload or handle empty content
    let data: unknown = null;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = text ? { detail: text } : null;
    }

    if (!response.ok) {
      const errorMsg =
        typeof data === 'object' && data !== null && 'detail' in data
          ? String((data as { detail: unknown }).detail)
          : response.statusText || `Request failed with status ${response.status}`;

      throw new ApiError(errorMsg, response.status, data);
    }

    return data as T;
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    if (err instanceof ApiError) {
      throw err;
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('Request timed out connecting to the backend server.', 504);
    }

    const message = err instanceof Error ? err.message : 'Network error connecting to Jarvis backend.';
    throw new ApiError(message);
  }
}

export const apiClient = {
  /**
   * Check system health (FastAPI, SQLite, Ollama).
   * GET /health
   */
  async getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>('/health', { method: 'GET' });
  },

  /**
   * List conversation sessions.
   * GET /sessions
   */
  async getSessions(): Promise<SessionSummary[]> {
    return request<SessionSummary[]>('/sessions', { method: 'GET' });
  },

  /**
   * Retrieve single session message history.
   * GET /sessions/{session_id}
   */
  async getSession(sessionId: string): Promise<SessionDetailResponse> {
    return request<SessionDetailResponse>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
  },

  /**
   * Send a chat message.
   * POST /chat
   */
  async sendChatMessage(payload: ChatRequest): Promise<ChatResponse> {
    return request<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

