/**
 * TypeScript API contracts strictly aligned with FastAPI backend Pydantic schemas.
 * (Source: backend/models/schemas.py)
 */

export interface ChatRequest {
  session_id: string;
  message: string;
}

export interface ChatResponse {
  session_id: string;
  reply: string;
  model: string;
  created_at: string;
}

export interface MessageSchema {
  id: number;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  created_at: string;
}

export interface SessionSummary {
  session_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message: string | null;
}

export interface SessionDetailResponse {
  session_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  total_messages: number;
  messages: MessageSchema[];
}

export interface OllamaHealth {
  status: 'connected' | 'unavailable' | string;
  base_url: string;
  target_model: string;
  model_available: boolean;
  detail: string | null;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy' | string;
  backend: string;
  database: string;
  ollama: OllamaHealth;
  timestamp: string;
}

