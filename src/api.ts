let csrfToken = '';
export function setCsrf(token: string): void { csrfToken = token; }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(path, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken ? { 'x-csrf-token': csrfToken } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? 'REQUEST_FAILED', body.message ?? `Request failed with status ${response.status}`);
  return body as T;
}

export function post<T>(path: string, body: unknown): Promise<T> { return api<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
export function del<T>(path: string): Promise<T> { return api<T>(path, { method: 'DELETE' }); }
