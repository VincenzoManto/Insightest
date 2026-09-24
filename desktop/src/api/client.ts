/** Thin fetch wrapper: attaches the JWT, throws on non-2xx with the server's error message. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function base64EncodeUtf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export class ApiClient {
  constructor(private baseUrl: string, private getToken: () => string | null) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.getToken();
    // Some hosting WAFs (e.g. Aruba shared hosting) strip raw `"` characters from POST
    // bodies, corrupting JSON. Base64-encode the body so it survives untouched; the
    // backend detects the X-Body-Encoding header and decodes it before parsing.
    const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;
    const encodedBody = jsonBody !== undefined ? base64EncodeUtf8(jsonBody) : undefined;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(encodedBody !== undefined ? { 'X-Body-Encoding': 'base64' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: encodedBody,
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
      throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
