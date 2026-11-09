/**
 * Centralized client-side passkey management for PROJECT JARVIS.
 * Stores user-provided passkey in browser localStorage.
 * Does not bundle or hardcode secrets in client distribution artifacts.
 */

const STORAGE_KEY = 'jarvis_passkey';

export const AUTH_CHANGE_EVENT = 'jarvis:auth-changed';
export const UNAUTHORIZED_EVENT = 'jarvis:unauthorized';

/**
 * Retrieve current authorization passkey from local storage.
 */
export function getAuthToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const token = localStorage.getItem(STORAGE_KEY);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Store validated authorization passkey and notify application listeners.
 */
export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, token.trim());
    window.dispatchEvent(
      new CustomEvent(AUTH_CHANGE_EVENT, { detail: { isAuthenticated: true } })
    );
  } catch (err) {
    console.error('[Auth] Failed to save passkey to localStorage:', err);
  }
}

/**
 * Clear stored authorization passkey and notify application listeners.
 */
export function clearAuthToken(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(
      new CustomEvent(AUTH_CHANGE_EVENT, { detail: { isAuthenticated: false } })
    );
  } catch (err) {
    console.error('[Auth] Failed to remove passkey from localStorage:', err);
  }
}

/**
 * Check whether a passkey is currently saved in local storage.
 */
export function isAuthenticated(): boolean {
  return getAuthToken() !== null;
}

