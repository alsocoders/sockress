import { nanoid } from 'nanoid';

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

interface SocketRequestPayload {
  type: 'request';
  id: string;
  method: HTTPMethod;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
}

interface SocketResponsePayload {
  type: 'response';
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  cookies?: string[];
}

interface SocketErrorPayload {
  type: 'error';
  id?: string;
  message: string;
  code?: string;
}

interface SocketEventPayload {
  type: 'event';
  event: string;
  data?: unknown;
}

export interface SockressClientOptions {
  baseUrl: string;
  socketPath?: string;
  headers?: Record<string, string>;
  timeout?: number;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  autoConnect?: boolean;
  preferSocket?: boolean;
  fetchImpl?: typeof fetch;
  wsFactory?: WebSocketFactory;
  credentials?: RequestCredentials;
}

export interface UploadProgress {
  loaded: number;
  total?: number;
  percentage?: number;
}

export interface SockressClientRequest {
  path: string;
  method?: HTTPMethod;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  disableHttpFallback?: boolean;
  onProgress?: (progress: UploadProgress) => void;
}

export interface SockressClientResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: T;
  json: <R = T>() => R;
  text: () => string;
  raw: () => T;
}

export type EventMap = {
  open: void;
  close: { code?: number; reason?: string };
  error: unknown;
  reconnect: { attempt: number };
  message: any;
};

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;
type CustomListener = (data: any) => void;

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): void;
  off?(type: string, listener: (...args: unknown[]) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

interface PendingRequest {
  resolve: (value: SockressClientResponse<any>) => void;
  reject: (reason?: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface NormalizedOptions {
  baseUrl: string;
  socketPath: string;
  headers: Record<string, string>;
  timeout: number;
  reconnectInterval: number;
  maxReconnectInterval: number;
  autoConnect: boolean;
  preferSocket: boolean;
  fetchImpl: typeof fetch;
  wsFactory?: WebSocketFactory;
  credentials: RequestCredentials;
}

export class SockressClient {
  private ws?: WebSocketLike;
  private reconnectAttempts = 0;
  private pending = new Map<string, PendingRequest>();
  private queue: Array<SocketRequestPayload | SocketEventPayload> = [];
  private listeners: { [K in keyof EventMap]: Set<Listener<K>> } = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    reconnect: new Set(),
    message: new Set()
  };
  private customListeners = new Map<string, Set<CustomListener>>();
  private socketEnabled = true;
  private lifecycleTeardown: Array<() => void> = [];
  private closeRequested = false;
  /** Stores cookies from socket responses (HttpOnly cookies can't be read from document.cookie) */
  private cookieStore = new Map<string, string>();

  constructor(private readonly options: NormalizedOptions) {
    if (options.autoConnect) {
      this.connect().catch(() => {
        // Ignore initial connection failures, HTTP fallback will handle requests.
      });
    }
    this.registerLifecycleHooks();
  }

  static create(options: SockressClientOptions): SockressClient {
    return new SockressClient(normalizeOptions(options));
  }

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void;
  on(event: string, listener: CustomListener): () => void;
  on(event: any, listener: any): () => void {
    if (Object.prototype.hasOwnProperty.call(this.listeners, event)) {
      this.listeners[event as keyof EventMap].add(listener as Listener<any>);
      return () => this.off(event as any, listener as any);
    }
    const key = String(event);
    const set = this.customListeners.get(key) ?? new Set<CustomListener>();
    set.add(listener as CustomListener);
    this.customListeners.set(key, set);
    return () => this.off(key, listener as any);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<K>): void;
  off(event: string, listener: CustomListener): void;
  off(event: any, listener: any): void {
    if (Object.prototype.hasOwnProperty.call(this.listeners, event)) {
      this.listeners[event as keyof EventMap].delete(listener as Listener<any>);
      return;
    }
    const key = String(event);
    const set = this.customListeners.get(key);
    if (!set) return;
    set.delete(listener as CustomListener);
    if (set.size === 0) {
      this.customListeners.delete(key);
    }
  }

  private emitInternal<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  private emitCustom(event: string, data: unknown): void {
    const set = this.customListeners.get(event);
    if (!set || !set.size) return;
    for (const listener of set) {
      listener(data as any);
    }
  }

  /**
   * Emit a custom realtime event to the server (socket transport only).
   * The payload can be anything: string, object, array, etc.
   */
  emit(event: string, data?: unknown): void {
    const name = String(event);
    if (!name) {
      throw new Error('emit(event, data) requires a non-empty event name');
    }
    if (!this.options.wsFactory) {
      this.socketEnabled = false;
      throw new Error('Socket transport is unavailable');
    }
    const payload: SocketEventPayload = { type: 'event', event: name, data };
    if (this.canUseSocket()) {
      this.ws!.send(JSON.stringify(payload));
      return;
    }
    // Queue until socket connects
    this.queue.push(payload);
    if (!this.closeRequested) {
      this.connect().catch(() => undefined);
    }
  }

  async connect(): Promise<void> {
    if (!this.options.wsFactory) {
      this.socketEnabled = false;
      return;
    }
    if (this.ws && this.ws.readyState === 1) {
      return;
    }
    // Clean up existing connection if any (but not if connecting)
    if (this.ws && this.ws.readyState !== 0 && this.ws.readyState !== 1) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = undefined;
    }
    // If already connecting, wait for it
    if (this.ws) {
      const currentState = this.ws.readyState;
      if (currentState === 0) {
        // Wait for connection to establish
        let attempts = 0;
        while (this.ws && this.ws.readyState === 0 && attempts < 30) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
        if (this.ws && this.ws.readyState === 1) {
          return;
        }
      } else if (currentState === 1) {
        return;
      }
    }
    const socketUrl = buildSocketUrl(this.options.baseUrl, this.options.socketPath);
    try {
      this.ws = this.options.wsFactory(socketUrl);
      this.attachSocketHandlers(this.ws);
      // Don't set socketEnabled to false here - wait for 'open' event
    } catch (error) {
      this.socketEnabled = false;
      this.emitInternal('error', error);
      throw error;
    }
  }

  private attachSocketHandlers(socket: WebSocketLike): void {
    const handleOpen = () => {
      this.reconnectAttempts = 0;
      this.socketEnabled = true;
      this.emitInternal('open', undefined);
      this.flushQueue();
    };
    const handleMessage = (event: unknown) => {
      const data = resolveEventData(event);
      if (data) {
        this.handleSocketMessage(data);
      }
    };
    const handleError = (event: unknown) => {
      this.emitInternal('error', event);
      // Don't disable socket on error - let it try to reconnect
      // Only reject pending requests, don't disable socket completely
      this.rejectAllPending(new Error('Socket error'));
    };
    const handleClose = (details?: { code?: number; reason?: string }) => {
      this.emitInternal('close', { code: details?.code, reason: details?.reason });
      // Only reject pending if we're not reconnecting
      if (!this.closeRequested) {
        this.rejectAllPending(new Error('Socket closed'));
        this.scheduleReconnect();
      }
    };
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', () => handleOpen());
      socket.addEventListener('message', (event) => handleMessage(event));
      socket.addEventListener('error', (event) => handleError(event));
      socket.addEventListener('close', (event) => handleClose(extractCloseDetails(event)));
    } else if (typeof socket.on === 'function') {
      socket.on('open', handleOpen);
      socket.on('message', (data: unknown) => handleMessage({ data }));
      socket.on('error', handleError);
      socket.on('close', (...args: unknown[]) => {
        const [code, reason] = args;
        handleClose({
          code: typeof code === 'number' ? code : undefined,
          reason: typeof reason === 'string' ? reason : typeof reason === 'object' && reason ? `${reason}` : undefined
        });
      });
    } else {
      socket.onopen = () => handleOpen();
      socket.onmessage = (event) => handleMessage(event);
      socket.onerror = (event) => handleError(event);
      socket.onclose = (event) => handleClose(extractCloseDetails(event));
    }
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    while (this.queue.length) {
      const payload = this.queue.shift();
      if (!payload) continue;
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (!this.socketEnabled || !this.options.wsFactory) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.options.reconnectInterval * this.reconnectAttempts,
      this.options.maxReconnectInterval
    );
    setTimeout(() => {
      this.emitInternal('reconnect', { attempt: this.reconnectAttempts });
      this.connect().catch(() => {
        // keep trying silently
      });
    }, delay);
  }

  private handleSocketMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw) as SocketResponsePayload | SocketErrorPayload | SocketEventPayload | any;

      // Handle broadcast messages (no id)
      if (payload.type && !payload.id && ['message', 'join', 'leave', 'room_created', 'room_deleted', 'error'].includes(payload.type)) {
        this.emitInternal('message', payload);
        return;
      }
      
      // Handle error responses
      if (payload.type === 'error') {
        const pending = payload.id ? this.pending.get(payload.id) : null;
        const error = new Error(payload.message);
        if (pending) {
          this.clearPending(payload.id!);
          pending.reject(error);
        } else {
          this.emitInternal('error', error);
        }
        return;
      }

      // Handle realtime event messages (no request/response)
      if (payload.type === 'event' && typeof payload.event === 'string') {
        // Fire custom listeners by name
        this.emitCustom(payload.event, payload.data);
        // Also expose via legacy 'message' channel for backwards compatibility
        this.emitInternal('message', { type: 'event', event: payload.event, data: payload.data });
        return;
      }
      
      // Handle response messages (must have type === 'response' and id)
      if (payload.type === 'response' && payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) {
          return;
        }
        this.clearPending(payload.id);
        const response = createClientResponse(payload as SocketResponsePayload);
        // Apply cookies from server response
        if (payload.cookies && Array.isArray(payload.cookies)) {
          this.applyCookies(payload.cookies);
        }
        pending.resolve(response);
        return;
      }
    } catch (error) {
      this.emitInternal('error', error);
    }
  }

  private applyCookies(cookies?: string[]): void {
    if (!cookies) return;
    for (const setCookie of cookies) {
      const [nameValue, ...attrs] = setCookie.split(';').map((s) => s.trim());
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx === -1) continue;
      const name = decodeURIComponent(nameValue.slice(0, eqIdx).trim());
      const value = nameValue.slice(eqIdx + 1).trim();
      let maxAge: number | null = null;
      for (const attr of attrs) {
        if (attr.toLowerCase().startsWith('max-age=')) {
          maxAge = parseInt(attr.split('=')[1] ?? '', 10);
          break;
        }
      }
      if (maxAge !== null && maxAge <= 0) {
        this.cookieStore.delete(name);
      } else {
        try {
          this.cookieStore.set(name, decodeURIComponent(value));
        } catch {
          this.cookieStore.set(name, value);
        }
      }
      if (typeof document !== 'undefined' && !setCookie.toLowerCase().includes('httponly')) {
        document.cookie = setCookie;
      }
    }
  }

  private getCookieHeader(): string {
    const map = new Map<string, string>();
    for (const [name, value] of this.cookieStore) {
      map.set(name, value);
    }
    if (typeof document !== 'undefined' && document.cookie) {
      for (const pair of document.cookie.split(';')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx === -1) continue;
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        if (!map.has(name)) map.set(name, decodeURIComponent(value));
      }
    }
    return Array.from(map.entries())
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('; ');
  }

  private clearPending(id: string): void {
    const pending = this.pending.get(id);
    if (pending?.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(id);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.clearPending(id);
      pending.reject(error);
    }
  }

  private registerLifecycleHooks(): void {
    const boundClose = () => this.close();
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      const handleSignal = () => boundClose();
      process.once('beforeExit', handleSignal);
      process.once('SIGINT', handleSignal);
      process.once('SIGTERM', handleSignal);
      this.lifecycleTeardown.push(() => {
        process.off('beforeExit', handleSignal);
        process.off('SIGINT', handleSignal);
        process.off('SIGTERM', handleSignal);
      });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const handleUnload = () => boundClose();
      window.addEventListener('beforeunload', handleUnload);
      this.lifecycleTeardown.push(() => window.removeEventListener('beforeunload', handleUnload));
    }
  }

  private canUseSocket(): boolean {
    if (!this.options.wsFactory || !this.socketEnabled) {
      return false;
    }
    if (!this.ws) {
      return false;
    }
    // Check readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    return this.ws.readyState === 1;
  }

  isConnected(): boolean {
    return this.canUseSocket();
  }

  disconnect(): void {
    this.close();
  }

  async request<T = unknown>(options: SockressClientRequest): Promise<SockressClientResponse<T>> {
    const method = (options.method || 'GET').toUpperCase() as HTTPMethod;
    const { pathname, query: urlQuery } = parseQueryFromPath(options.path);
    const path = normalizePath(pathname);
    const headers = { ...this.options.headers, ...(options.headers ?? {}) };
    const objectQuery = options.query ? normalizeQuery(options.query) : {};
    const mergedQuery = { ...urlQuery, ...objectQuery };
    const query = Object.keys(mergedQuery).length > 0 ? mergedQuery : undefined;
    const timeout = options.timeout ?? this.options.timeout;
    const onProgress = options.onProgress;

    if (this.options.preferSocket && this.options.wsFactory) {
      // If socket is enabled or we have a factory, try socket first
      if (this.socketEnabled || this.options.wsFactory !== undefined) {
        try {
          return await this.sendViaSocket<T>({ method, path, headers, query, body: options.body, timeout, onProgress });
        } catch (error) {
          if (options.disableHttpFallback) {
            throw error;
          }
          // If socket fails and we're still trying to connect, wait a bit more
          if (!this.canUseSocket() && this.options.wsFactory !== undefined && !this.closeRequested) {
            // Try connecting once more
            try {
              await this.connect();
              // Wait a bit longer for React Native
              let attempts = 0;
              while (!this.canUseSocket() && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 150));
                attempts++;
              }
              if (this.canUseSocket()) {
                return await this.sendViaSocket<T>({ method, path, headers, query, body: options.body, timeout, onProgress });
              }
            } catch (retryError) {
              // Fall through to HTTP
            }
          }
        }
      }
    }
    return this.sendViaHttp<T>({ method, path, headers, query, body: options.body, signal: options.signal, onProgress });
  }

  get<T = unknown>(
    path: string,
    options?: Omit<SockressClientRequest, 'path' | 'method'>
  ): Promise<SockressClientResponse<T>> {
    return this.request<T>({ ...(options ?? {}), path, method: 'GET' });
  }

  post<T = unknown>(
    path: string,
    options?: Omit<SockressClientRequest, 'path' | 'method'>
  ): Promise<SockressClientResponse<T>> {
    return this.request<T>({ ...(options ?? {}), path, method: 'POST' });
  }

  put<T = unknown>(
    path: string,
    options?: Omit<SockressClientRequest, 'path' | 'method'>
  ): Promise<SockressClientResponse<T>> {
    return this.request<T>({ ...(options ?? {}), path, method: 'PUT' });
  }

  patch<T = unknown>(
    path: string,
    options?: Omit<SockressClientRequest, 'path' | 'method'>
  ): Promise<SockressClientResponse<T>> {
    return this.request<T>({ ...(options ?? {}), path, method: 'PATCH' });
  }

  delete<T = unknown>(
    path: string,
    options?: Omit<SockressClientRequest, 'path' | 'method'>
  ): Promise<SockressClientResponse<T>> {
    return this.request<T>({ ...(options ?? {}), path, method: 'DELETE' });
  }

  private async sendViaSocket<T>(input: {
    method: HTTPMethod;
    path: string;
    headers: Record<string, string>;
    query?: Record<string, string | string[]>;
    body?: unknown;
    timeout: number;
    onProgress?: (progress: UploadProgress) => void;
  }): Promise<SockressClientResponse<T>> {
    if (!this.options.wsFactory) {
      this.socketEnabled = false;
      throw new Error('Socket transport is unavailable');
    }
    
    // Try to connect if not connected
    if (!this.canUseSocket()) {
      try {
        await this.connect();
        // Wait longer for connection to establish (especially for React Native)
        // React Native WebSocket can take longer to connect
        let attempts = 0;
        const maxAttempts = 30; // 3 seconds total wait time
        while (!this.canUseSocket() && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
          // Check if socket is connecting (readyState === 0)
          if (this.ws && this.ws.readyState === 0) {
            // Still connecting, continue waiting
            continue;
          }
          // If socket closed or errored, try reconnecting once
          if (this.ws && (this.ws.readyState === 2 || this.ws.readyState === 3)) {
            if (attempts < 5) {
              // Try reconnecting once more
              try {
                await this.connect();
                attempts = 0; // Reset attempts
              } catch {
                // Ignore reconnect error, will throw below
              }
            }
          }
        }
      } catch (error) {
        throw new Error(`Failed to connect socket: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    if (!this.canUseSocket()) {
      throw new Error('Socket is not connected after connection attempt');
    }
    const headers = { ...input.headers };
    if (this.options.credentials === 'include') {
      const cookieHeader = this.getCookieHeader();
      if (cookieHeader) {
        const existing = headers['Cookie'] || headers['cookie'];
        headers['Cookie'] = existing ? `${existing}; ${cookieHeader}` : cookieHeader;
      }
    }
    const id = nanoid();
    const serializedBody = await serializeBodyForSocket(input.body, input.onProgress);
    const payload: SocketRequestPayload = {
      type: 'request',
      id,
      method: input.method,
      path: input.path,
      headers,
      query: input.query,
      body: serializedBody
    };
    const responsePromise = new Promise<SockressClientResponse<T>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.clearPending(id);
        reject(new Error('Socket request timed out'));
      }, input.timeout);
      this.pending.set(id, { resolve, reject, timeout });
    });
    const serialized = JSON.stringify(payload);
    if (this.canUseSocket()) {
      try {
        this.ws!.send(serialized);
      } catch (error) {
        this.clearPending(id);
        throw new Error(`Failed to send via socket: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.queue.push(payload);
    }
    return responsePromise;
  }

  private async sendViaHttp<T>(input: {
    method: HTTPMethod;
    path: string;
    headers: Record<string, string>;
    query?: Record<string, string | string[]>;
    body?: unknown;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
  }): Promise<SockressClientResponse<T>> {
    const url = buildHttpUrl(this.options.baseUrl, input.path, input.query);
    
    // Use XMLHttpRequest for upload progress tracking if onProgress is provided
    if (input.onProgress && (isFormData(input.body) || isBlob(input.body))) {
      return this.sendViaXHR<T>(url, input);
    }
    
    // Fallback to fetch for non-file uploads or when progress tracking not needed
    const headers = new Headers(input.headers);
    const init: RequestInit = {
      method: input.method,
      headers,
      credentials: this.options.credentials,
      signal: input.signal
    };
    if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
      if (
        typeof input.body === 'string' ||
        input.body instanceof URLSearchParams ||
        isBlob(input.body) ||
        isFormData(input.body)
      ) {
        init.body = input.body as BodyInit;
      } else {
        init.body = JSON.stringify(input.body);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      }
    }
    const response = await this.options.fetchImpl(url, init);
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (setCookies?.length && this.options.credentials === 'include') {
      this.applyCookies(setCookies);
    }
    const text = await response.text();
    let parsed: unknown = text;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers: headersObj,
      body: parsed as T,
      json: <R>() => parsed as R,
      text: () => text,
      raw: () => parsed as T
    };
  }

  private sendViaXHR<T>(url: string, input: {
    method: HTTPMethod;
    headers: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
  }): Promise<SockressClientResponse<T>> {
    return new Promise((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') {
        // Fallback to fetch if XHR is not available
        return this.sendViaHttpFallback<T>(url, input).then(resolve).catch(reject);
      }

      const xhr = new XMLHttpRequest();
      
      // Handle abort signal
      if (input.signal) {
        const abortHandler = () => {
          xhr.abort();
          reject(new Error('Request aborted'));
        };
        if (input.signal.aborted) {
          abortHandler();
          return;
        }
        input.signal.addEventListener('abort', abortHandler);
      }

      // Set up upload progress tracking
      if (input.onProgress && xhr.upload) {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            input.onProgress!({
              loaded: event.loaded,
              total: event.total,
              percentage: event.total > 0 ? Math.round((event.loaded / event.total) * 100) : undefined
            });
          } else {
            input.onProgress!({
              loaded: event.loaded
            });
          }
        });
      }

      xhr.addEventListener('load', () => {
        const text = xhr.responseText;
        let parsed: unknown = text;
        const contentType = xhr.getResponseHeader('content-type') ?? '';
        if (contentType.includes('application/json') && text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        const headersObj: Record<string, string> = {};
        const allHeaders = xhr.getAllResponseHeaders();
        if (allHeaders) {
          allHeaders.split('\r\n').forEach((line) => {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
              const key = line.substring(0, colonIndex).trim().toLowerCase();
              const value = line.substring(colonIndex + 1).trim();
              if (key && value) {
                headersObj[key] = value;
              }
            }
          });
        }
        resolve({
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 300,
          headers: headersObj,
          body: parsed as T,
          json: <R>() => parsed as R,
          text: () => text,
          raw: () => parsed as T
        });
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Network error'));
      });

      xhr.addEventListener('abort', () => {
        reject(new Error('Request aborted'));
      });

      xhr.open(input.method, url, true);
      
      // Set headers (skip Content-Type for FormData - browser sets it automatically with boundary)
      const isFormDataBody = isFormData(input.body);
      Object.entries(input.headers).forEach(([key, value]) => {
        // Don't set Content-Type header for FormData - browser will set it with boundary
        if (isFormDataBody && key.toLowerCase() === 'content-type') {
          return;
        }
        xhr.setRequestHeader(key, value);
      });

      // Set credentials
      if (this.options.credentials === 'include') {
        xhr.withCredentials = true;
      }

      // Send request
      if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
        xhr.send(input.body as any);
      } else {
        xhr.send();
      }
    });
  }

  private async sendViaHttpFallback<T>(url: string, input: {
    method: HTTPMethod;
    headers: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<SockressClientResponse<T>> {
    const headers = new Headers(input.headers);
    const init: RequestInit = {
      method: input.method,
      headers,
      credentials: this.options.credentials,
      signal: input.signal
    };
    if (input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD') {
      if (
        typeof input.body === 'string' ||
        input.body instanceof URLSearchParams ||
        isBlob(input.body) ||
        isFormData(input.body)
      ) {
        init.body = input.body as BodyInit;
      } else {
        init.body = JSON.stringify(input.body);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      }
    }
    const response = await this.options.fetchImpl(url, init);
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (setCookies?.length && this.options.credentials === 'include') {
      this.applyCookies(setCookies);
    }
    const text = await response.text();
    let parsed: unknown = text;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const headersObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers: headersObj,
      body: parsed as T,
      json: <R>() => parsed as R,
      text: () => text,
      raw: () => parsed as T
    };
  }

  close(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.socketEnabled = false;
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.queue = [];
    this.rejectAllPending(new Error('Client closed'));
    this.lifecycleTeardown.forEach((teardown) => teardown());
    this.lifecycleTeardown = [];
  }
}

export function sockressClient(options: SockressClientOptions): SockressClient {
  return SockressClient.create(options);
}

export const createSockressClient = sockressClient;

function getWebSocketConstructor(): typeof WebSocket | undefined {
  // Check multiple possible locations for WebSocket
  if (typeof WebSocket !== 'undefined') {
    return WebSocket;
  }
  // React Native / Expo
  if (typeof global !== 'undefined' && (global as any).WebSocket) {
    return (global as any).WebSocket;
  }
  // Node.js environment
  if (typeof globalThis !== 'undefined' && (globalThis as any).WebSocket) {
    return (globalThis as any).WebSocket;
  }
  // Try to require for Node.js environments
  try {
    if (typeof require !== 'undefined') {
      return require('ws');
    }
  } catch {
    // Ignore require errors
  }
  return undefined;
}

function normalizeOptions(options: SockressClientOptions): NormalizedOptions {
  if (!options.baseUrl) {
    throw new Error('baseUrl is required');
  }
  let fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('Fetch implementation is not available in this environment');
  }
  if (fetchImpl === globalThis.fetch && typeof fetchImpl === 'function') {
    const originalFetch = fetchImpl;
    fetchImpl = ((...args: Parameters<typeof fetch>) => {
      return originalFetch.apply(globalThis, args);
    }) as typeof fetch;
  }
  const WebSocketConstructor = getWebSocketConstructor();
  const wsFactory =
    options.wsFactory ??
    (WebSocketConstructor ? (url: string) => new WebSocketConstructor(url) as WebSocketLike : undefined);
  return {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    socketPath: options.socketPath ?? '/sockress',
    headers: { ...(options.headers ?? {}) },
    timeout: options.timeout ?? 15_000,
    reconnectInterval: options.reconnectInterval ?? 1_000,
    maxReconnectInterval: options.maxReconnectInterval ?? 15_000,
    autoConnect: options.autoConnect ?? true,
    preferSocket: options.preferSocket ?? true,
    fetchImpl,
    wsFactory,
    credentials: options.credentials ?? 'include'
  };
}

async function serializeBodyForSocket(body: unknown, onProgress?: (progress: UploadProgress) => void): Promise<unknown> {
  if (isFormData(body)) {
    return {
      __formData: await serializeFormData(body, onProgress)
    };
  }
  return body;
}

async function serializeFormData(formData: FormData, onProgress?: (progress: UploadProgress) => void): Promise<{
  fields: Record<string, string | string[]>;
  files: Record<string, SerializedSocketFilePayload[]>;
}> {
  const fields: Record<string, string | string[]> = {};
  const files: Record<string, SerializedSocketFilePayload[]> = {};
  const entries: Array<[string, any]> = collectFormDataEntries(formData);
  
  // Calculate total size for progress tracking
  let totalSize = 0;
  const fileEntries: Array<{ key: string; value: any; size: number }> = [];
  
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      if (fields[key]) {
        const existing = fields[key];
        fields[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        fields[key] = value;
      }
      continue;
    }
    const size = value.size || 0;
    totalSize += size;
    fileEntries.push({ key, value, size });
  }
  
  // Serialize files with progress tracking
  let loadedSize = 0;
  for (const { key, value, size } of fileEntries) {
    const fileBuffer = await value.arrayBuffer();
    
    // Report progress after reading file
    loadedSize += size;
    if (onProgress) {
      onProgress({
        loaded: loadedSize,
        total: totalSize,
        percentage: totalSize > 0 ? Math.round((loadedSize / totalSize) * 100) : undefined
      });
    }
    
    const encoded = arrayBufferToBase64(fileBuffer);
    if (!files[key]) {
      files[key] = [];
    }
    files[key].push({
      fieldName: key,
      name: value.name ?? 'file',
      type: value.type ?? 'application/octet-stream',
      size: value.size,
      lastModified: typeof value.lastModified === 'number' ? value.lastModified : undefined,
      data: encoded
    });
  }
  
  // Report 100% completion if we had files and progress callback
  if (onProgress && fileEntries.length > 0 && totalSize > 0) {
    onProgress({
      loaded: totalSize,
      total: totalSize,
      percentage: 100
    });
  }
  
  return { fields, files };
}

interface SerializedSocketFilePayload {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  data: string;
  lastModified?: number;
}

function buildSocketUrl(baseUrl: string, socketPath: string): string {
  const url = new URL(socketPath, baseUrl);
  url.protocol = url.protocol.replace('http', 'ws');
  return url.toString();
}

function buildHttpUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | string[]>
): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => url.searchParams.append(key, entry));
      } else {
        url.searchParams.append(key, value);
      }
    }
  }
  return url.toString();
}

function normalizePath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return path;
}

function parseQueryFromPath(
  path: string
): { pathname: string; query: Record<string, string | string[]> } {
  const qIdx = path.indexOf('?');
  if (qIdx === -1) {
    return { pathname: path, query: {} };
  }
  const pathname = path.slice(0, qIdx) || '/';
  const search = path.slice(qIdx + 1);
  const query: Record<string, string | string[]> = {};
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    const values = params.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return { pathname, query };
}

function normalizeQuery(
  query: Record<string, string | number | boolean | Array<string | number | boolean>>
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      result[key] = value.map((item) => String(item));
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

function createClientResponse<T = unknown>(payload: SocketResponsePayload): SockressClientResponse<T> {
  const headers = payload.headers ?? {};
  const status = payload.status;
  const body = payload.body as T;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    json: <R = T>() => body as unknown as R,
    text: () => (typeof body === 'string' ? body : JSON.stringify(body)),
    raw: () => body
  };
}

function extractCloseDetails(event: unknown): { code?: number; reason?: string } {
  if (!event || typeof event !== 'object') return {};
  const closeEvent = event as Partial<CloseEvent>;
  return {
    code: closeEvent.code,
    reason: closeEvent.reason
  };
}

function resolveEventData(event: unknown): string {
  if (!event) return '';
  if (typeof event === 'string') return event;
  if (typeof event === 'object' && 'data' in (event as Record<string, unknown>)) {
    return toText((event as { data: unknown }).data);
  }
  return toText(event);
}

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return textDecoder ? textDecoder.decode(value) : '';
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (textDecoder) {
      return textDecoder.decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
  }
  if (value && typeof (value as { toString: () => string }).toString === 'function') {
    return (value as { toString: () => string }).toString();
  }
  return '';
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  throw new Error('Base64 encoding is not supported in this environment');
}

function collectFormDataEntries(formData: FormData): Array<[string, any]> {
  const anyForm = formData as any;
  const entries: Array<[string, any]> = [];
  if (typeof anyForm.entries === 'function') {
    for (const pair of anyForm.entries()) {
      entries.push(pair);
    }
    return entries;
  }
  if (typeof anyForm[Symbol.iterator] === 'function') {
    for (const pair of anyForm as Iterable<[string, any]>) {
      entries.push(pair);
    }
    return entries;
  }
  throw new Error('FormData implementation does not support iteration');
}

