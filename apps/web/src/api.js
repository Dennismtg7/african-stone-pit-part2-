import { auth } from './firebase.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export async function getToken() {
  return auth?.currentUser?.getIdToken() || null;
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  const token = await getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function socketUrl() {
  return API_URL;
}
