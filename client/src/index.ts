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

export interface SockressClientRequest {
  path: string;
  method?: HTTPMethod;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  disableHttpFallback?: boolean;
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
  private queue: SocketRequestPayload[] = [];
  private listeners: { [K in keyof EventMap]: Set<Listener<K>> } = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    reconnect: new Set(),
    message: new Set()
  };
  private socketEnabled = true;
  private lifecycleTeardown: Array<() => void> = [];
  private closeRequested = false;

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

  on<K extends keyof EventMap>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener as Listener<K>);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<K>): void {
    this.listeners[event].delete(listener as Listener<K>);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
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
    const socketUrl = buildSocketUrl(this.options.baseUrl, this.options.socketPath);
    this.ws = this.options.wsFactory(socketUrl);
    this.attachSocketHandlers(this.ws);
  }

  private attachSocketHandlers(socket: WebSocketLike): void {
    const handleOpen = () => {
      this.reconnectAttempts = 0;
      this.emit('open', undefined);
      this.flushQueue();
    };
    const handleMessage = (event: unknown) => {
      const data = resolveEventData(event);
      if (data) {
        this.handleSocketMessage(data);
      }
    };
    const handleError = (event: unknown) => {
      this.emit('error', event);
      this.rejectAllPending(new Error('Socket error'));
    };
    const handleClose = (details?: { code?: number; reason?: string }) => {
      this.emit('close', { code: details?.code, reason: details?.reason });
      this.rejectAllPending(new Error('Socket closed'));
      this.scheduleReconnect();
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
      this.emit('reconnect', { attempt: this.reconnectAttempts });
      this.connect().catch(() => {
        // keep trying silently
      });
    }, delay);
  }

  private handleSocketMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw) as SocketResponsePayload | SocketErrorPayload | any;

      if (payload.type && !payload.id && ['message', 'join', 'leave', 'room_created', 'room_deleted', 'error'].includes(payload.type)) {
        this.emit('message', payload);
        return;
      }
      
      if (payload.type === 'error') {
        const pending = payload.id ? this.pending.get(payload.id) : null;
        const error = new Error(payload.message);
        if (pending) {
          this.clearPending(payload.id!);
          pending.reject(error);
        } else {
          this.emit('error', error);
        }
        return;
      }
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      this.clearPending(payload.id);
      const response = createClientResponse(payload);
      this.applyCookies(payload.cookies);
      pending.resolve(response);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private applyCookies(cookies?: string[]): void {
    if (!cookies || typeof document === 'undefined') return;
    for (const cookie of cookies) {
      document.cookie = cookie;
    }
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
    return Boolean(this.options.wsFactory && this.socketEnabled && this.ws && this.ws.readyState === 1);
  }

  async request<T = unknown>(options: SockressClientRequest): Promise<SockressClientResponse<T>> {
    const method = (options.method || 'GET').toUpperCase() as HTTPMethod;
    const path = normalizePath(options.path);
    const headers = { ...this.options.headers, ...(options.headers ?? {}) };
    const query = options.query ? normalizeQuery(options.query) : undefined;
    const timeout = options.timeout ?? this.options.timeout;

    if (this.options.preferSocket && this.socketEnabled) {
      try {
        return await this.sendViaSocket<T>({ method, path, headers, query, body: options.body, timeout });
      } catch (error) {
        if (options.disableHttpFallback) {
          throw error;
        }
      }
    }
    return this.sendViaHttp<T>({ method, path, headers, query, body: options.body, signal: options.signal });
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
  }): Promise<SockressClientResponse<T>> {
    if (!this.options.wsFactory) {
      this.socketEnabled = false;
      throw new Error('Socket transport is unavailable');
    }
    await this.connect();
    const id = nanoid();
    const serializedBody = await serializeBodyForSocket(input.body);
    const payload: SocketRequestPayload = {
      type: 'request',
      id,
      method: input.method,
      path: input.path,
      headers: input.headers,
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
      this.ws!.send(serialized);
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
  }): Promise<SockressClientResponse<T>> {
    const url = buildHttpUrl(this.options.baseUrl, input.path, input.query);
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
  const wsFactory =
    options.wsFactory ??
    (typeof WebSocket !== 'undefined' ? (url: string) => new WebSocket(url) as WebSocketLike : undefined);
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

async function serializeBodyForSocket(body: unknown): Promise<unknown> {
  if (isFormData(body)) {
    return {
      __formData: await serializeFormData(body)
    };
  }
  return body;
}

async function serializeFormData(formData: FormData): Promise<{
  fields: Record<string, string | string[]>;
  files: Record<string, SerializedSocketFilePayload[]>;
}> {
  const fields: Record<string, string | string[]> = {};
  const files: Record<string, SerializedSocketFilePayload[]> = {};
  const entries: Array<[string, any]> = collectFormDataEntries(formData);
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
    const fileBuffer = await value.arrayBuffer();
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

