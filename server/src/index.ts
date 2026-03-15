import http, { IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import type { Socket } from 'net';
import { TLSSocket } from 'tls';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Options as MulterOptions } from 'multer';
import type { Multer } from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';

export interface SockressAddress extends AddressInfo {
  hostname: string;
  url: string;
}

type ListenCallback = (error: Error | null, address?: SockressAddress) => void;

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type NextFunction = (err?: unknown) => void;
export type SockressHandler = (req: SockressRequest, res: SockressResponse, next: NextFunction) => unknown;
export type SockressErrorHandler = (err: unknown, req: SockressRequest, res: SockressResponse, next?: NextFunction) => unknown;

export type SockressLogLevel = false | 'error' | 'warn' | 'info' | 'debug';

export interface SockressOptions {
  cors?: Partial<CorsOptions>;
  socket?: Partial<SocketOptions>;
  bodyLimit?: number;
  logging?: SockressLogLevel;
}

interface SocketOptions {
  path: string;
  heartbeatInterval: number;
  idleTimeout: number;
}

interface CorsOptions {
  origin: string | string[];
  credentials: boolean;
  methods: HTTPMethod[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  maxAge: number;
}

interface NormalizedOptions {
  cors: CorsOptions;
  socket: SocketOptions;
  bodyLimit: number;
  logging: SockressLogLevel;
}

class SockressLogger {
  private level: SockressLogLevel;

  constructor(level: SockressLogLevel) {
    this.level = level;
  }

  private shouldLog(level: 'error' | 'warn' | 'info' | 'debug'): boolean {
    if (this.level === false) return false;
    const levels: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
    const currentLevel = levels[this.level] ?? 0;
    const requestedLevel = levels[level] ?? 0;
    return requestedLevel <= currentLevel;
  }

  error(...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(...args);
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.log(...args);
    }
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.log(...args);
    }
  }
}

export interface SockressUploaderOptions {
  dest?: string;
  limits?: MulterOptions['limits'];
  preserveFilename?: boolean;
}

export interface SockressUploader {
  single(field: string): SockressHandler;
  array(field: string, maxCount?: number): SockressHandler;
  fields(
    fields: Array<{
      name: string;
      maxCount?: number;
    }>
  ): SockressHandler;
  any(): SockressHandler;
}

export interface StaticOptions {
  index?: string;
  maxAge?: number;
  stripPrefix?: string;
}

interface MiddlewareLayer {
  path: string;
  handler: SockressHandler | SockressErrorHandler;
  isErrorHandler: boolean;
}

interface RouteLayer {
  method: HTTPMethod | 'ALL';
  matcher: PathMatcher;
  handlers: Array<SockressHandler | SockressErrorHandler>;
}

interface PipelineLayer {
  handler: SockressHandler | SockressErrorHandler;
  isErrorHandler: boolean;
}

interface PathMatcher {
  raw: string;
  match: (path: string) => PathMatchResult | null;
}

interface PathMatchResult {
  params: Record<string, string>;
}

type RequestMode =
  | { kind: 'http'; req: IncomingMessage; res: ServerResponse }
  | { kind: 'socket'; socket: WebSocket; requestId: string };

type IncomingSocketMessage =
  | {
      type: 'request';
      id?: string;
      method?: string;
      path?: string;
      headers?: Record<string, string | string[]>;
      query?: Record<string, string | string[]>;
      body?: unknown;
    }
  | {
      type: 'event';
      event?: string;
      data?: unknown;
    };

type OutgoingSocketMessage =
  | {
      type: 'response' | 'error';
      id?: string;
      status?: number;
      headers?: Record<string, string>;
      body?: unknown;
      message?: string;
      code?: string;
      cookies?: string[];
    }
  | {
      type: 'event';
      event: string;
      data?: unknown;
    };

export interface SockressSocketContext {
  socket: WebSocket;
  raw: IncomingMessage;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string>;
  ip: string | undefined;
}

export type SockressSocketEventHandler = (data: unknown, ctx: SockressSocketContext) => void;

export interface SockressUploadedFile {
  fieldName: string;
  name: string;
  type: string;
  size: number;
  buffer: Buffer;
  lastModified?: number;
  path?: string;
}

export interface SockressRequest {
  readonly id: string;
  readonly method: HTTPMethod;
  path: string;
  query: Record<string, string | string[]>;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  cookies: Record<string, string>;
  file?: SockressUploadedFile;
  files?: Record<string, SockressUploadedFile[]>;
  readonly type: 'http' | 'socket';
  readonly ip: string | undefined;
  readonly protocol: 'http' | 'https' | 'ws' | 'wss';
  readonly secure: boolean;
  context: Record<string, unknown>;
  raw?: IncomingMessage;
  readonly hostname?: string;
  readonly originalUrl?: string;
  readonly baseUrl?: string;
  readonly subdomains?: string[];
  get(field: string): string | undefined;
  accepts(types: string | string[]): string | false;
  is(type: string | string[]): string | false | null;
  param(name: string, defaultValue?: string): string;
}

export class SockressRequestImpl implements SockressRequest {
  public params: Record<string, string> = {};
  public context: Record<string, unknown> = {};
  public readonly hostname?: string;
  public readonly originalUrl?: string;
  public readonly baseUrl?: string;
  public readonly subdomains?: string[];

  constructor(
    public readonly id: string,
    public readonly method: HTTPMethod,
    public path: string,
    public query: Record<string, string | string[]>,
    public headers: Record<string, string | string[] | undefined>,
    public body: unknown,
    public cookies: Record<string, string>,
    public files: Record<string, SockressUploadedFile[]> | undefined,
    public file: SockressUploadedFile | undefined,
    public readonly type: 'http' | 'socket',
    public readonly ip: string | undefined,
    public readonly protocol: 'http' | 'https' | 'ws' | 'wss',
    public readonly secure: boolean,
    public raw?: IncomingMessage,
    originalUrl?: string,
    baseUrl?: string
  ) {
    const host = this.get('host') || '';
    this.hostname = host.split(':')[0] || undefined;
    this.originalUrl = originalUrl;
    this.baseUrl = baseUrl || '';
    this.subdomains = this.hostname ? extractSubdomains(this.hostname) : [];
  }

  get(field: string): string | undefined {
    const key = field.toLowerCase();
    const value = this.headers[key];
    if (Array.isArray(value)) {
      return value[0];
    }
    if (typeof value === 'number') {
      return String(value);
    }
    return value as string | undefined;
  }

  accepts(types: string | string[]): string | false {
    const acceptHeader = this.get('accept') || '*/*';
    const acceptTypes = acceptHeader.split(',').map((t) => t.trim().split(';')[0].toLowerCase());
    const requestedTypes = Array.isArray(types) ? types : [types];
    for (const requested of requestedTypes) {
      const normalized = requested.toLowerCase();
      if (acceptTypes.includes(normalized) || acceptTypes.includes('*/*')) {
        return requested;
      }
      const mimeType = normalized.includes('/') ? normalized : `application/${normalized}`;
      if (acceptTypes.some((at) => at === mimeType || at.startsWith(mimeType.split('/')[0] + '/*'))) {
        return requested;
      }
    }
    return false;
  }

  is(type: string | string[]): string | false | null {
    const contentType = (this.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const types = Array.isArray(type) ? type : [type];
    for (const t of types) {
      const normalized = t.toLowerCase();
      if (contentType === normalized || contentType.startsWith(normalized + '/')) {
        return t;
      }
    }
    return contentType ? false : null;
  }

  param(name: string, defaultValue?: string): string {
    return this.params[name] ?? defaultValue ?? '';
  }
}

export class SockressResponse {
  private statusCode = 200;
  private sent = false;
  private streaming = false;
  private headers: Record<string, string> = {};
  private cookies: string[] = [];
  private _raw?: ServerResponse & { _sockressHeadersApplied?: boolean };

  constructor(
    private readonly mode: RequestMode,
    private readonly cors: CorsOptions,
    private readonly allowedOrigin: string,
    private readonly logger: SockressLogger
  ) {
    if (mode.kind === 'http') {
      this._raw = mode.res as ServerResponse & { _sockressHeadersApplied?: boolean };
    }
  }

  get raw(): ServerResponse | undefined {
    if (this.mode.kind === 'http' && this._raw) {
      this.ensureHeadersApplied();
      return this._raw;
    }
    return this._raw;
  }

  private ensureHeadersApplied(): void {
    if (this.mode.kind !== 'http' || !this._raw || this._raw.headersSent) {
      return;
    }
    if (this._raw._sockressHeadersApplied) {
      return;
    }
    const headersWithCors = this.buildHeaders();
    this._raw.statusCode = this.statusCode;
    Object.entries(headersWithCors).forEach(([key, value]) => {
      if (!this._raw!.getHeader(key)) {
        this._raw!.setHeader(key, value);
      }
    });
    if (this.cookies.length) {
      this._raw.setHeader('Set-Cookie', this.cookies);
    }
    this._raw._sockressHeadersApplied = true;
  }

  status(code: number): this {
    this.statusCode = code;
    if (this._raw && !this._raw.headersSent) {
      try {
        this._raw.statusCode = code;
      } catch (error) {
        // Ignore errors if status can't be set
      }
    }
    return this;
  }

  set(field: string, value: string): this {
    if (this.sent && !this.streaming) {
      this.logger.warn(`[Sockress] Cannot set header "${field}" after response has been sent`);
      return this;
    }
    this.headers[field.toLowerCase()] = value;
    if (this._raw && !this._raw.headersSent) {
      try {
        this._raw.setHeader(field, value);
      } catch (error) {
        // Ignore errors if header can't be set
      }
    }
    return this;
  }

  setHeader(name: string, value: string | number | string[]): this {
    return this.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }

  getHeader(name: string): string | number | string[] | undefined {
    if (this._raw) {
      return this._raw.getHeader(name);
    }
    return this.headers[name.toLowerCase()];
  }

  removeHeader(name: string): this {
    if (this.sent && !this.streaming) {
      this.logger.warn(`[Sockress] Cannot remove header "${name}" after response has been sent`);
      return this;
    }
    delete this.headers[name.toLowerCase()];
    if (this._raw && !this._raw.headersSent) {
      try {
        this._raw.removeHeader(name);
      } catch (error) {
        // Ignore errors if header can't be removed
      }
    }
    return this;
  }



  append(field: string, value: string): this {
    const current = this.headers[field.toLowerCase()];
    if (current) {
      this.headers[field.toLowerCase()] = `${current}, ${value}`;
    } else {
      this.headers[field.toLowerCase()] = value;
    }
    if (this._raw && !this._raw.headersSent) {
      try {
        this._raw.appendHeader(field, value);
      } catch (error) {
        // Ignore errors if header can't be appended
      }
    }
    return this;
  }

  cookie(name: string, value: string, options: CookieSerializeOptions = {}): this {
    this.cookies.push(serializeCookie(name, value, options));
    return this;
  }

  clearCookie(name: string, options: CookieSerializeOptions = {}): this {
    return this.cookie(name, '', { ...options, maxAge: 0 });
  }

  json(payload: unknown): this {
    this.set('content-type', 'application/json; charset=utf-8');
    return this.send(payload);
  }

  send(payload?: unknown): this {
    if (this.sent || this.streaming) {
      return this;
    }
    this.sent = true;
    if (!this.headers['content-type'] && typeof payload === 'string') {
      this.headers['content-type'] = 'text/plain; charset=utf-8';
    }
    const headersWithCors = this.buildHeaders();
    if (this.mode.kind === 'http') {
      const res = this.mode.res;
      // Check if headers have already been sent
      if (res.headersSent) {
        this.logger.warn('[Sockress] Attempted to send response after headers were already sent');
        return this;
      }
      try {
        res.statusCode = this.statusCode;
        Object.entries(headersWithCors).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        if (this.cookies.length) {
          res.setHeader('Set-Cookie', this.cookies);
        }
        if (Buffer.isBuffer(payload)) {
          res.end(payload);
        } else if (typeof payload === 'string') {
          res.end(payload);
        } else if (payload === undefined || payload === null) {
          res.end();
        } else {
          const buffer = Buffer.from(JSON.stringify(payload));
          if (!this.headers['content-type']) {
            res.setHeader('content-type', 'application/json; charset=utf-8');
          }
          res.end(buffer);
        }
      } catch (error) {
        this.logger.error('[Sockress] Error sending response:', error);
        // Try to send error response if possible
        if (!res.headersSent) {
          try {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Internal Server Error', details: error instanceof Error ? error.message : String(error) }));
          } catch {
            // Ignore if we can't send error response
          }
        }
      }
      return this;
    }

    const message: OutgoingSocketMessage = {
      type: 'response',
      id: this.mode.requestId,
      status: this.statusCode,
      headers: headersWithCors,
      body: payload,
      cookies: this.cookies.length ? [...this.cookies] : undefined
    };
    this.mode.socket.send(JSON.stringify(message));
    return this;
  }

  end(chunk?: any, encoding?: BufferEncoding, callback?: () => void): this {
    if (this.sent || (this._raw && (this._raw.writableEnded || this._raw.destroyed))) {
      return this;
    }
    if (this.streaming) {
      if (this.mode.kind === 'http' && this._raw) {
        try {
          if (encoding !== undefined && callback !== undefined) {
            this._raw.end(chunk, encoding, callback);
          } else if (encoding !== undefined) {
            this._raw.end(chunk, encoding);
          } else if (callback !== undefined) {
            this._raw.end(chunk, callback);
          } else if (chunk !== undefined) {
            this._raw.end(chunk);
          } else {
            this._raw.end();
          }
          this.sent = true;
        } catch (error) {
          this.logger.error('[Sockress] Error ending stream:', error);
        }
        return this;
      }
    }
    if (chunk !== undefined || encoding !== undefined || callback !== undefined) {
      if (this.mode.kind === 'http' && this._raw) {
        if (!this.streaming) {
          this.streaming = true;
          this.ensureHeadersApplied();
        }
        try {
          if (encoding !== undefined && callback !== undefined) {
            this._raw.end(chunk, encoding, callback);
          } else if (encoding !== undefined) {
            this._raw.end(chunk, encoding);
          } else if (callback !== undefined) {
            this._raw.end(chunk, callback);
          } else if (chunk !== undefined) {
            this._raw.end(chunk);
          } else {
            this._raw.end();
          }
          this.sent = true;
        } catch (error) {
          this.logger.error('[Sockress] Error ending stream:', error);
        }
        return this;
      }
    }
    return this.send();
  }

  isSent(): boolean {
    return this.sent;
  }

  redirect(url: string | number, statusOrUrl?: number | string): this {
    if (typeof url === 'number') {
      this.statusCode = url;
      const target = typeof statusOrUrl === 'string' ? statusOrUrl : '/';
      this.set('Location', target);
      return this.send();
    }
    const status = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
    this.status(status);
    this.set('Location', url);
    return this.send();
  }

  sendFile(filePath: string, options?: { root?: string; headers?: Record<string, string> }): Promise<this> {
    return new Promise(async (resolve, reject) => {
      try {
        const resolvedPath = options?.root ? path.join(options.root, filePath) : path.resolve(filePath);
        const stats = await fsp.stat(resolvedPath);
        if (!stats.isFile()) {
          reject(new Error('Path is not a file'));
          return;
        }
        const buffer = await fsp.readFile(resolvedPath);
        if (options?.headers) {
          Object.entries(options.headers).forEach(([key, value]) => {
            this.set(key, value);
          });
        }
        this.set('content-type', mimeFromExtension(path.extname(resolvedPath)));
        this.set('content-length', stats.size.toString());
        this.send(buffer);
        resolve(this);
      } catch (error) {
        reject(error);
      }
    });
  }

  download(filePath: string, filename?: string, options?: { root?: string; headers?: Record<string, string> }): Promise<this> {
    return new Promise(async (resolve, reject) => {
      try {
        const resolvedPath = options?.root ? path.join(options.root, filePath) : path.resolve(filePath);
        const stats = await fsp.stat(resolvedPath);
        if (!stats.isFile()) {
          reject(new Error('Path is not a file'));
          return;
        }
        const buffer = await fsp.readFile(resolvedPath);
        const downloadName = filename || path.basename(resolvedPath);
        if (options?.headers) {
          Object.entries(options.headers).forEach(([key, value]) => {
            this.set(key, value);
          });
        }
        this.set('content-disposition', `attachment; filename="${downloadName}"`);
        this.set('content-type', mimeFromExtension(path.extname(resolvedPath)));
        this.set('content-length', stats.size.toString());
        this.send(buffer);
        resolve(this);
      } catch (error) {
        reject(error);
      }
    });
  }

  sendStatus(code: number): this {
    this.status(code);
    const statusText = getStatusText(code);
    return this.send(statusText);
  }

  format(obj: Record<string, (req: SockressRequest, res: SockressResponse) => void>, req: SockressRequest): this {
    if (this.sent) return this;
    const accept = req.get('accept') || '*/*';
    const keys = Object.keys(obj);
    for (const key of keys) {
      if (accept.includes(key) || key === 'default') {
        const handler = obj[key];
        if (handler) {
          handler(req, this);
          return this;
        }
      }
    }
    if (obj.default) {
      obj.default(req, this);
    }
    return this;
  }

  location(url: string): this {
    return this.set('Location', url);
  }

  vary(field: string): this {
    const current = this.headers['vary'];
    if (current) {
      this.set('Vary', `${current}, ${field}`);
    } else {
      this.set('Vary', field);
    }
    return this;
  }

  getSocket(): WebSocket | undefined {
    if (this.mode.kind === 'socket') {
      return this.mode.socket;
    }
    return undefined;
  }

  /**
   * Emit a realtime event to the connected socket (socket requests only).
   * No-op for HTTP requests.
   *
   * NOTE: Named `emitEvent` because `res.emit()` already exists for HTTP stream events.
   */
  emitEvent(event: string, data?: unknown): this {
    if (this.mode.kind !== 'socket') {
      return this;
    }
    const name = String(event);
    if (!name) {
      return this;
    }
    const message: OutgoingSocketMessage = {
      type: 'event',
      event: name,
      data
    };
    try {
      this.mode.socket.send(JSON.stringify(message));
    } catch {
      // ignore send errors
    }
    return this;
  }

  pipe(destination: NodeJS.WritableStream): this {
    if (this.mode.kind !== 'http' || !this._raw) {
      throw new Error('Streaming is only supported for HTTP requests');
    }
    if (this.sent) {
      throw new Error('Cannot pipe after response has been sent');
    }
    if (!this.streaming) {
      this.streaming = true;
      this.ensureHeadersApplied();
    }
    if (destination && typeof destination === 'object' && 'pipe' in destination) {
      (destination as any).pipe(this._raw);
    } else {
      this._raw.pipe(destination as any);
    }
    return this;
  }

  write(chunk: any, encoding?: BufferEncoding, callback?: (error?: Error | null) => void): boolean {
    if (this.mode.kind !== 'http' || !this._raw) {
      if (callback) {
        callback(new Error('Streaming is only supported for HTTP requests'));
      }
      return false;
    }
    if (this.sent || this._raw.writableEnded || this._raw.destroyed) {
      if (callback) {
        callback(new Error('Cannot write after response has been sent or ended'));
      }
      return false;
    }
    if (!this.streaming) {
      this.streaming = true;
      this.ensureHeadersApplied();
    }
    try {
      if (encoding !== undefined && callback !== undefined) {
        return this._raw.write(chunk, encoding, callback);
      } else if (encoding !== undefined) {
        return this._raw.write(chunk, encoding);
      } else if (callback !== undefined) {
        return this._raw.write(chunk, callback);
      } else {
        return this._raw.write(chunk);
      }
    } catch (error) {
      if (callback) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
      return false;
    }
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (this.mode.kind === 'http' && this._raw) {
      this._raw.on(event, listener);
    }
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    if (this.mode.kind === 'http' && this._raw) {
      this._raw.once(event, listener);
    }
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    if (this.mode.kind === 'http' && this._raw) {
      this._raw.off(event, listener);
    }
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    if (this.mode.kind === 'http' && this._raw) {
      this._raw.removeListener(event, listener);
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (this.mode.kind === 'http' && this._raw) {
      this._raw.removeAllListeners(event);
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    if (this.mode.kind === 'http' && this._raw) {
      return this._raw.emit(event, ...args);
    }
    return false;
  }

  listeners(event: string): Function[] {
    if (this.mode.kind === 'http' && this._raw) {
      return this._raw.listeners(event);
    }
    return [];
  }

  listenerCount(event: string): number {
    if (this.mode.kind === 'http' && this._raw) {
      return this._raw.listenerCount(event);
    }
    return 0;
  }

  addListener(event: string, listener: (...args: any[]) => void): this {
    return this.on(event, listener);
  }


  private buildHeaders(): Record<string, string> {
    const headers = { ...this.headers };
    headers['access-control-allow-origin'] = this.allowedOrigin;
    headers['access-control-allow-credentials'] = String(this.cors.credentials);
    headers['access-control-allow-methods'] = this.cors.methods.join(', ');
    headers['access-control-allow-headers'] = this.cors.allowedHeaders.join(', ');
    headers['access-control-expose-headers'] = this.cors.exposedHeaders.join(', ');
    headers['access-control-max-age'] = String(this.cors.maxAge);
    return headers;
  }
}

export class SockressRouter {
  private middlewares: MiddlewareLayer[] = [];
  private routes: RouteLayer[] = [];

  use(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this;
  use(...handlers: Array<SockressHandler | SockressErrorHandler>): this;
  use(
    pathOrHandler: string | SockressHandler | SockressErrorHandler,
    ...rest: Array<SockressHandler | SockressErrorHandler>
  ): this {
    let path = '/';
    let stack: Array<SockressHandler | SockressErrorHandler> = [];
    if (typeof pathOrHandler === 'string') {
      path = pathOrHandler;
      stack = rest;
    } else {
      stack = [pathOrHandler, ...rest];
    }
    if (!stack.length) {
      throw new Error('use() requires at least one handler');
    }
    for (const handler of stack) {
      if (!handler) continue;
      // Error handler detection: 4 parameters = error handler (err, req, res, next)
      // 3 parameters can be error handler (err, req, res) if next is optional
      // We detect by length: 4 = definitely error handler, 3 = could be error handler or regular middleware
      // For now, only 4 parameters = error handler (Express standard)
      // 3-parameter error handlers will be detected dynamically when err is present
      this.middlewares.push({
        path,
        handler,
        isErrorHandler: handler.length === 4
      });
    }
    return this;
  }

  private register(method: HTTPMethod | 'ALL', path: string, handlers: Array<SockressHandler | SockressErrorHandler>): this {
    if (!handlers.length) {
      throw new Error(`Route ${method} ${path} requires at least one handler`);
    }
    this.routes.push({
      method,
      matcher: buildMatcher(path),
      handlers
    });
    return this;
  }

  get(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('GET', path, handlers);
  }

  post(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('POST', path, handlers);
  }

  put(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('PUT', path, handlers);
  }

  patch(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('PATCH', path, handlers);
  }

  delete(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('DELETE', path, handlers);
  }

  head(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('HEAD', path, handlers);
  }

  options(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('OPTIONS', path, handlers);
  }

  all(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('ALL', path, handlers);
  }

  route(path: string): SockressRoute {
    return new SockressRoute(this, path);
  }

  getStack(): { middlewares: MiddlewareLayer[]; routes: RouteLayer[] } {
    return { middlewares: this.middlewares, routes: this.routes };
  }
}

export class SockressRoute {
  constructor(private router: SockressRouter, private path: string) {}

  get(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.get(this.path, ...handlers);
    return this;
  }

  post(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.post(this.path, ...handlers);
    return this;
  }

  put(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.put(this.path, ...handlers);
    return this;
  }

  patch(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.patch(this.path, ...handlers);
    return this;
  }

  delete(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.delete(this.path, ...handlers);
    return this;
  }

  head(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.head(this.path, ...handlers);
    return this;
  }

  options(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.options(this.path, ...handlers);
    return this;
  }

  all(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.router.all(this.path, ...handlers);
    return this;
  }
}

export class SockressAppRoute {
  constructor(private app: SockressApp, private path: string) {}

  get(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.get(this.path, ...handlers);
    return this;
  }

  post(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.post(this.path, ...handlers);
    return this;
  }

  put(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.put(this.path, ...handlers);
    return this;
  }

  patch(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.patch(this.path, ...handlers);
    return this;
  }

  delete(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.delete(this.path, ...handlers);
    return this;
  }

  head(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.head(this.path, ...handlers);
    return this;
  }

  options(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.options(this.path, ...handlers);
    return this;
  }

  all(...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    this.app.all(this.path, ...handlers);
    return this;
  }
}

interface StackEntry {
  type: 'middleware' | 'route';
  middleware?: MiddlewareLayer;
  route?: RouteLayer;
}

export class SockressApp {
  private stack: StackEntry[] = [];
  private paramHandlers: Map<string, SockressHandler> = new Map();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private heartbeatInterval?: NodeJS.Timeout;
  private shutdownRegistered = false;
  private shuttingDown = false;
  private sockets: Set<WebSocket> = new Set();
  private socketContexts: WeakMap<WebSocket, SockressSocketContext> = new WeakMap();
  private socketEventHandlers: Map<string, Set<SockressSocketEventHandler>> = new Map();
  private readonly logger: SockressLogger;

  constructor(private readonly config: NormalizedOptions) {
    this.logger = new SockressLogger(config.logging);
  }

  static Router(): SockressRouter {
    return new SockressRouter();
  }

  static create(options?: SockressOptions): SockressApp {
    return new SockressApp(normalizeOptions(options));
  }

  use(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler | SockressRouter>): this;
  use(...handlers: Array<SockressHandler | SockressErrorHandler | SockressRouter>): this;
  use(
    pathOrHandler: string | SockressHandler | SockressErrorHandler | SockressRouter,
    ...rest: Array<SockressHandler | SockressErrorHandler | SockressRouter>
  ): this {
    let path = '/';
    let stack: Array<SockressHandler | SockressErrorHandler | SockressRouter> = [];
    if (typeof pathOrHandler === 'string') {
      path = pathOrHandler;
      stack = rest;
    } else {
      stack = [pathOrHandler, ...rest];
    }
    if (!stack.length) {
      throw new Error('use() requires at least one handler');
    }
    for (const item of stack) {
      if (!item) continue;
      if (item instanceof SockressRouter) {
        const routerStack = item.getStack();
        for (const layer of routerStack.middlewares) {
          this.stack.push({
            type: 'middleware',
            middleware: {
              path: path === '/' ? layer.path : `${path}${layer.path === '/' ? '' : layer.path}`,
              handler: layer.handler,
              isErrorHandler: layer.isErrorHandler
            }
          });
        }
        for (const route of routerStack.routes) {
          this.stack.push({
            type: 'route',
            route: {
              method: route.method,
              matcher: buildMatcher(path === '/' ? route.matcher.raw : `${path}${route.matcher.raw}`),
              handlers: route.handlers
            }
          });
        }
      } else {
        this.stack.push({
          type: 'middleware',
          middleware: {
            path,
            handler: item as SockressHandler | SockressErrorHandler,
            isErrorHandler: (item as SockressHandler | SockressErrorHandler).length === 4
          }
        });
      }
    }
    return this;
  }

  useStatic(route: string, directory: string, options?: StaticOptions): this {
    const handler = serveStatic(directory, { ...options, stripPrefix: options?.stripPrefix ?? route });
    return this.use(route, handler);
  }

  private register(method: HTTPMethod | 'ALL', path: string, handlers: Array<SockressHandler | SockressErrorHandler>): this {
    if (!handlers.length) {
      throw new Error(`Route ${method} ${path} requires at least one handler`);
    }
    this.stack.push({
      type: 'route',
      route: {
        method,
        matcher: buildMatcher(path),
        handlers
      }
    });
    return this;
  }

  get(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('GET', path, handlers);
  }

  post(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('POST', path, handlers);
  }

  put(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('PUT', path, handlers);
  }

  patch(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('PATCH', path, handlers);
  }

  delete(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('DELETE', path, handlers);
  }

  head(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('HEAD', path, handlers);
  }

  options(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('OPTIONS', path, handlers);
  }

  all(path: string, ...handlers: Array<SockressHandler | SockressErrorHandler>): this {
    return this.register('ALL', path, handlers);
  }

  param(name: string, handler: SockressHandler): this {
    this.paramHandlers.set(name, handler);
    return this;
  }

  route(path: string): SockressAppRoute {
    return new SockressAppRoute(this, path);
  }

  /**
   * Subscribe to realtime events sent from clients via WebSocket.
   * Use `event="*"` to listen to all events.
   */
  on(event: string, handler: SockressSocketEventHandler): () => void {
    const key = String(event);
    if (!key) {
      throw new Error('app.on(event, handler) requires a non-empty event name');
    }
    const set = this.socketEventHandlers.get(key) ?? new Set<SockressSocketEventHandler>();
    set.add(handler);
    this.socketEventHandlers.set(key, set);
    return () => this.off(key, handler);
  }

  off(event: string, handler: SockressSocketEventHandler): void {
    const key = String(event);
    const set = this.socketEventHandlers.get(key);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.socketEventHandlers.delete(key);
    }
  }

  /**
   * Emit a realtime event to all connected websocket clients.
   * (Socket transport only; HTTP clients won't receive this.)
   */
  emit(event: string, data?: unknown): void {
    const name = String(event);
    if (!name) return;
    const message: OutgoingSocketMessage = { type: 'event', event: name, data };
    const serialized = JSON.stringify(message);
    for (const socket of this.sockets) {
      try {
        if ((socket as any).readyState === (WebSocket as any).OPEN) {
          socket.send(serialized);
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Emit a realtime event to a specific websocket.
   */
  emitTo(socket: WebSocket, event: string, data?: unknown): void {
    const name = String(event);
    if (!name) return;
    const message: OutgoingSocketMessage = { type: 'event', event: name, data };
    try {
      if ((socket as any).readyState === (WebSocket as any).OPEN) {
        socket.send(JSON.stringify(message));
      }
    } catch {
      // ignore
    }
  }

  listen(port: number, callback?: ListenCallback): http.Server;
  listen(port: number, host: string, callback?: ListenCallback): http.Server;
  listen(port: number, hostOrCallback?: string | ListenCallback, maybeCallback?: ListenCallback): http.Server {
    let host: string | undefined;
    let callback: ListenCallback | undefined;
    if (typeof hostOrCallback === 'function') {
      callback = hostOrCallback;
    } else {
      host = hostOrCallback;
      callback = maybeCallback;
    }

    if (this.server) {
      throw new Error('Sockress server is already running');
    }
    const httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
      if (pathname !== this.config.socket.path) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      // React Native/Expo apps might not send origin header, or send null/undefined
      // Allow connection if origin is missing and CORS is set to allow all
      if (origin === undefined || origin === null || origin === 'null') {
        // If CORS allows all origins, allow connection without origin
        if (this.config.cors.origin === '*') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
          return;
        }
        // Otherwise check if empty origin is explicitly allowed
        if (Array.isArray(this.config.cors.origin) && this.config.cors.origin.includes('*')) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
          return;
        }
      }
      if (!isOriginAllowed(origin, this.config.cors.origin)) {
        this.logger.warn(`[Sockress] WebSocket connection rejected: origin "${origin}" not allowed. Allowed origins:`, this.config.cors.origin);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    wss.on('connection', (socket, req) => this.handleSocket(socket, req));
    this.server = httpServer;
    this.wss = wss;
    const listener = httpServer.listen(port, host, () => {
      const addressInfo = httpServer.address();
      if (!addressInfo || typeof addressInfo === 'string') {
        callback?.(null, undefined);
        return;
      }
      callback?.(null, enhanceAddressInfo(addressInfo, host));
    });
    httpServer.on('error', (err) => callback?.(err));
    this.startHeartbeat();
    this.registerShutdownHooks();
    return listener;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.server
        ? new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())))
        : Promise.resolve(),
      this.wss
        ? new Promise<void>((resolve, reject) => this.wss!.close((err) => (err ? reject(err) : resolve())))
        : Promise.resolve()
    ]);
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }

  private startHeartbeat(): void {
    if (!this.wss) return;
    this.heartbeatInterval = setInterval(() => {
      this.wss?.clients.forEach((socket: WebSocket & { isAlive?: boolean }) => {
        if (socket.isAlive === false) {
          return socket.terminate();
        }
        socket.isAlive = false;
        socket.ping();
      });
    }, this.config.socket.heartbeatInterval);
  }

  private registerShutdownHooks(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;
    if (typeof process === 'undefined' || !process.on) {
      return;
    }
    const finalize = () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.close().catch(() => undefined);
    };
    process.once('beforeExit', finalize);
    process.once('SIGINT', finalize);
    process.once('SIGTERM', finalize);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const { method = 'GET' } = req;
      const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname || '/';
      const query = parseQuery(url.searchParams);
      const cookieResult = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
      const cookies: Record<string, string> = {};
      for (const [key, value] of Object.entries(cookieResult)) {
        if (value !== undefined) {
          cookies[key] = value;
        }
      }
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      const skipBodyParsing = contentType.startsWith('multipart/form-data');
      let parsedBody: unknown;
      if (!skipBodyParsing) {
        const body = await readBody(req, this.config.bodyLimit);
        parsedBody = parseBody(body, req.headers['content-type']);
      }
      const normalizedPayload = normalizeBodyPayload(parsedBody);
      const primaryFile = pickPrimaryFile(normalizedPayload.files);
      const secure = isSocketEncrypted(req.socket as Socket);
      const originalUrl = req.url || '/';
      const sockressReq = new SockressRequestImpl(
        generateId(),
        method.toUpperCase() as HTTPMethod,
        path,
        query,
        req.headers,
        normalizedPayload.body,
        cookies,
        normalizedPayload.files,
        primaryFile,
        'http',
        getIp(req),
        secure ? 'https' : 'http',
        secure,
        req,
        originalUrl,
        ''
      );
      const origin = pickOrigin(req.headers.origin as string | undefined, this.config.cors.origin);
      const sockressRes = new SockressResponse({ kind: 'http', req, res }, this.config.cors, origin, this.logger);
      if (sockressReq.method === 'OPTIONS') {
        sockressRes.status(204).end();
        return;
      }
      await this.runPipeline(sockressReq, sockressRes);
    } catch (error) {
      // Check if response headers have already been sent
      if (!res.headersSent) {
        try {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          const errorMessage = error instanceof Error ? error.message : String(error);
          res.end(JSON.stringify({ error: 'Internal Server Error', details: errorMessage }));
        } catch (sendError) {
          // If we can't send error response, just log it
          this.logger.error('[Sockress] Failed to send error response:', sendError);
        }
      } else {
        // Headers already sent, can't send error response
        this.logger.error('[Sockress] Error occurred after headers were sent:', error);
      }
    }
  }

  private handleSocket(socket: WebSocket & { isAlive?: boolean }, req: IncomingMessage): void {
    this.sockets.add(socket);
    const cookieResult = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
    const cookies: Record<string, string> = {};
    for (const [key, value] of Object.entries(cookieResult)) {
      if (value !== undefined) {
        cookies[key] = value;
      }
    }
    const ctx: SockressSocketContext = {
      socket,
      raw: req,
      headers: req.headers,
      cookies,
      ip: getIp(req)
    };
    this.socketContexts.set(socket, ctx);

    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      // WeakMap entry will be GC'd automatically
    });
    socket.on('message', async (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as IncomingSocketMessage;
        if (payload.type === 'event') {
          const eventName = typeof payload.event === 'string' ? payload.event : '';
          if (!eventName) {
            return socket.send(JSON.stringify({ type: 'error', message: 'Invalid event name' }));
          }
          const current = this.socketContexts.get(socket) ?? ctx;
          this.dispatchSocketEvent(eventName, payload.data, current);
          return;
        }
        if (payload.type !== 'request') {
          return socket.send(JSON.stringify({ type: 'error', message: 'Unsupported message type' }));
        }
        const path = payload.path || '/';
        const method = (payload.method || 'GET').toUpperCase() as HTTPMethod;
        const query = payload.query ?? {};
        const headers = normalizeHeaders(payload.headers ?? {});
        const cookieHeader = headers.cookie;
        const cookieString = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
        const cookieResult = typeof cookieString === 'string' ? parseCookie(cookieString) : {};
        const cookies: Record<string, string> = {};
        for (const [key, value] of Object.entries(cookieResult)) {
          if (value !== undefined) {
            cookies[key] = value;
          }
        }
        const secure = isSocketEncrypted(req.socket as Socket);
        const normalizedPayload = normalizeBodyPayload(payload.body);
        const primaryFile = pickPrimaryFile(normalizedPayload.files);
        const originalUrl = payload.path || '/';
        const sockressReq = new SockressRequestImpl(
          payload.id ?? generateId(),
          method,
          path,
          query,
          headers,
          normalizedPayload.body,
          cookies,
          normalizedPayload.files,
          primaryFile,
          'socket',
          getIp(req),
          secure ? 'wss' : 'ws',
          secure,
          undefined,
          originalUrl,
          ''
        );
        const origin = pickOrigin(req.headers.origin as string | undefined, this.config.cors.origin);
        const sockressRes = new SockressResponse({ kind: 'socket', socket, requestId: sockressReq.id }, this.config.cors, origin, this.logger);
        await this.runPipeline(sockressReq, sockressRes);
      } catch (error) {
        const outgoing: OutgoingSocketMessage = {
          type: 'error',
          message: error instanceof Error ? error.message : 'Unexpected socket payload'
        };
        socket.send(JSON.stringify(outgoing));
      }
    });
  }

  private dispatchSocketEvent(event: string, data: unknown, ctx: SockressSocketContext): void {
    const direct = this.socketEventHandlers.get(event);
    if (direct) {
      for (const handler of direct) {
        try {
          handler(data, ctx);
        } catch (err) {
          // ignore handler errors to avoid breaking socket loop
        }
      }
    }
    const wildcard = this.socketEventHandlers.get('*');
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler({ event, data }, ctx);
        } catch {
          // ignore
        }
      }
    }
  }

  private async runPipeline(req: SockressRequest, res: SockressResponse): Promise<void> {
    const stack = this.composeStack(req, req.method);
    let idx = 0;
    const next: NextFunction = async (err?: unknown) => {
      const layer = stack[idx++];
        if (!layer) {
          if (err) {
            try {
              this.renderError(err, req, res);
            } catch (renderError) {
              this.logger.error('[Sockress] renderError failed:', renderError);
              try {
                const rawRes = res.raw;
                if (rawRes && !rawRes.headersSent) {
                  rawRes.statusCode = 500;
                  rawRes.setHeader('content-type', 'application/json; charset=utf-8');
                  rawRes.end(JSON.stringify({
                    error: 'Internal Server Error',
                    details: err instanceof Error ? err.message : String(err)
                  }));
                }
              } catch (fallbackError) {
                this.logger.error('[Sockress] Fallback error response also failed:', fallbackError);
              }
            }
          } else if (!res.isSent()) {
            try {
              const message = `Cannot ${req.method} ${req.path}`;
              res.status(404).send(message);
            } catch (statusError) {
              this.logger.error('[Sockress] Failed to send 404 response:', statusError);
              try {
                const rawRes = res.raw;
                if (rawRes && !rawRes.headersSent) {
                  const message = `Cannot ${req.method} ${req.path}`;
                  rawRes.statusCode = 404;
                  rawRes.setHeader('content-type', 'text/plain; charset=utf-8');
                  rawRes.end(message);
                }
              } catch (fallbackError) {
                this.logger.error('[Sockress] Fallback 404 response also failed:', fallbackError);
              }
            }
          }
          return;
        }
      const handler = layer.handler;
      const isErrorHandler = layer.isErrorHandler;
      try {
        if (err) {
          if (isErrorHandler) {
            try {
              const errorHandler = handler as SockressErrorHandler;
              await errorHandler(err, req, res, next);
            } catch (handlerError) {
              if (handlerError instanceof Error && handlerError.message.includes('status is not a function')) {
                this.renderError(err, req, res);
                return;
              }
              await next(handlerError);
            }
          } else if (handler.length === 3) {
            try {
              await (handler as any)(err, req, res);
              return;
            } catch (handlerError) {
              if (handlerError instanceof Error && handlerError.message.includes('status is not a function')) {
                this.renderError(err, req, res);
                return;
              }
              await next(err);
            }
          } else {
            await next(err);
          }
          return;
        }
        if (isErrorHandler) {
          await next();
          return;
        }
        await (handler as SockressHandler)(req, res, next);
      } catch (error) {
        await next(error);
      }
    };
    await next();
  }

  private composeStack(req: SockressRequest, method: HTTPMethod): PipelineLayer[] {
    const { path } = req;
    const pipeline: PipelineLayer[] = [];
    
    for (const entry of this.stack) {
      if (entry.type === 'middleware' && entry.middleware) {
        const layer = entry.middleware;
        if (matchesPrefix(layer.path, path)) {
          pipeline.push({
            handler: layer.handler,
            isErrorHandler: layer.isErrorHandler
          });
        }
      } else if (entry.type === 'route' && entry.route) {
        const route = entry.route;
        if (route.method !== method && route.method !== 'ALL') {
          continue;
        }
        const match = route.matcher.match(path);
        if (!match) continue;
        
        req.params = { ...match.params };
        
        for (const [paramName] of Object.entries(match.params)) {
          const paramHandler = this.paramHandlers.get(paramName);
          if (paramHandler) {
            const wrapped: SockressHandler = (request, res, next) => {
              request.params = { ...match.params };
              return paramHandler(request, res, next);
            };
            pipeline.push({ handler: wrapped, isErrorHandler: false });
          }
        }
        
        for (const handler of route.handlers) {
          // Only 4-parameter handlers are error handlers in routes
          // 3-parameter handlers in routes are regular middleware (req, res, next)
          const isErrorHandler = handler.length === 4;
          if (isErrorHandler) {
            const wrapped: SockressErrorHandler = (err, request, res, next) => {
              request.params = { ...match.params };
              return (handler as SockressErrorHandler)(err, request, res, next);
            };
            pipeline.push({ handler: wrapped, isErrorHandler: true });
          } else {
            const wrapped: SockressHandler = (request, res, next) => {
              request.params = { ...match.params };
              return (handler as SockressHandler)(request, res, next);
            };
            pipeline.push({ handler: wrapped, isErrorHandler: false });
          }
        }
      }
    }
    
    return pipeline;
  }

  private renderError(err: unknown, req: SockressRequest, res: SockressResponse): void {
    if (res.isSent()) {
      this.logger.error('[Sockress] Error occurred but response already sent:', err);
      return;
    }
    try {
      res.status(500).json({
        error: 'Internal Server Error',
        details: err instanceof Error ? err.message : String(err)
      });
    } catch (sendError) {
      this.logger.error('[Sockress] Failed to send error response:', sendError);
      this.logger.error('[Sockress] Original error:', err);
      try {
        const rawRes = res.raw;
        if (rawRes && !rawRes.headersSent) {
          rawRes.statusCode = 500;
          rawRes.setHeader('content-type', 'application/json; charset=utf-8');
          rawRes.end(JSON.stringify({
            error: 'Internal Server Error',
            details: err instanceof Error ? err.message : String(err)
          }));
        }
      } catch (fallbackError) {
        this.logger.error('[Sockress] Fallback error response also failed:', fallbackError);
      }
    }
  }
}

export function sockress(options?: SockressOptions): SockressApp {
  return SockressApp.create(options);
}

export const createSockress = sockress;
export const Router = SockressApp.Router;

export default sockress;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = sockress;
  module.exports.sockress = sockress;
  module.exports.createSockress = createSockress;
  module.exports.Router = Router;
  module.exports.SockressApp = SockressApp;
  module.exports.SockressRouter = SockressRouter;
  module.exports.SockressRoute = SockressRoute;
  module.exports.SockressAppRoute = SockressAppRoute;
  module.exports.SockressRequest = SockressRequestImpl;
  module.exports.SockressResponse = SockressResponse;
  module.exports.createUploader = createUploader;
  module.exports.serveStatic = serveStatic;
  module.exports.default = sockress;
}

function normalizeOptions(options?: SockressOptions): NormalizedOptions {
  const cors: CorsOptions = {
    origin: options?.cors?.origin ?? '*',
    credentials: options?.cors?.credentials ?? true,
    methods: options?.cors?.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: options?.cors?.allowedHeaders ?? ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: options?.cors?.exposedHeaders ?? [],
    maxAge: options?.cors?.maxAge ?? 600
  };
  const socket: SocketOptions = {
    path: options?.socket?.path ?? '/sockress',
    heartbeatInterval: options?.socket?.heartbeatInterval ?? 30_000,
    idleTimeout: options?.socket?.idleTimeout ?? 120_000
  };
  const bodyLimit = options?.bodyLimit ?? 1_000_000;
  const logging = options?.logging ?? false;
  return { cors, socket, bodyLimit, logging };
}

function buildMatcher(path: string): PathMatcher {
  if (path === '*' || path === '/*') {
    return {
      raw: path,
      match: (incoming: string) => ({ params: { wild: incoming.replace(/^\//, '') } })
    };
  }
  const keys: string[] = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      if (segment.startsWith(':')) {
        const key = segment.replace(/^:/, '').replace(/\?$/, '');
        keys.push(key);
        return segment.endsWith('?') ? '(?:\\/([^/]+))?' : '\\/([^/]+)';
      }
      if (segment === '*') {
        keys.push('wild');
        return '\\/(.*)';
      }
      return `\\/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  const regex = new RegExp(`^${pattern || '\\/'}\\/?$`);
  return {
    raw: path,
    match: (incoming: string) => {
      const exec = regex.exec(incoming === '' ? '/' : incoming);
      if (!exec) {
        return null;
      }
      const params: Record<string, string> = {};
      keys.forEach((key, index) => {
        const value = exec[index + 1];
        if (value !== undefined) {
          params[key] = decodeURIComponent(value);
        }
      });
      return { params };
    }
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function parseBody(buffer: Buffer, contentType?: string): unknown {
  if (!buffer.length) return undefined;
  const type = contentType?.split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    const text = buffer.toString('utf8');
    return text ? JSON.parse(text) : undefined;
  }
  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(buffer.toString('utf8'));
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of params.entries()) {
      if (result[key]) {
        const existing = result[key];
        result[key] = Array.isArray(existing) ? [...existing, value] : [existing as string, value];
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return buffer;
}

export interface CookieSerializeOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: true | 'lax' | 'strict' | 'none';
}

function parseCookie(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!str || typeof str !== 'string') return result;
  const pairs = str.split(';');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      result[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function serializeCookie(name: string, value: string, options: CookieSerializeOptions = {}): string {
  const encoded = encodeURIComponent(value);
  const parts = [`${encodeURIComponent(name)}=${encoded}`];
  if (options.path != null) parts.push(`Path=${options.path}`);
  if (options.domain != null) parts.push(`Domain=${options.domain}`);
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires != null) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite != null) {
    const s = options.sameSite === true ? 'Strict' : String(options.sameSite);
    parts.push(`SameSite=${s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()}`);
  }
  return parts.join('; ');
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function generateId(size = 21): string {
  const bytes = crypto.randomBytes(size);
  let result = '';
  for (let i = 0; i < size; i++) {
    result += ID_ALPHABET[bytes[i]! % 64];
  }
  return result;
}

function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    if (result[key]) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing as string, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

function matchesPrefix(base: string, path: string): boolean {
  if (base === '/' || base === '') return true;
  if (!base.startsWith('/')) {
    base = `/${base}`;
  }
  return path === base || path.startsWith(`${base}/`);
}

function getIp(req: IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (Array.isArray(forwarded)) {
    return forwarded[0];
  }
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? undefined;
}

function isOriginAllowed(originHeader: string | undefined, allowed: string | string[]): boolean {
  // Allow all origins
  if (allowed === '*') return true;
  // If no origin header (React Native/Expo might not send it), only allow if '*' is in allowed list
  if (!originHeader || originHeader === 'null') {
    if (Array.isArray(allowed)) {
      return allowed.includes('*');
    }
    return false;
  }
  if (Array.isArray(allowed)) {
    return allowed.includes(originHeader) || allowed.includes('*');
  }
  return allowed === originHeader;
}

function pickOrigin(requestOrigin: string | undefined, allowed: string | string[]): string {
  if (allowed === '*') return '*';
  if (Array.isArray(allowed)) {
    if (requestOrigin && allowed.includes(requestOrigin)) {
      return requestOrigin;
    }
    return allowed[0] ?? '*';
  }
  return allowed;
}

function isSocketEncrypted(socket: Socket): boolean {
  return socket instanceof TLSSocket && Boolean(socket.encrypted);
}

interface SocketFormDataEnvelope {
  fields?: Record<string, string | string[]>;
  files?: Record<string, SerializedSocketFile[]>;
}

interface SerializedSocketFile {
  fieldName?: string;
  name?: string;
  type?: string;
  size?: number;
  data: string;
  lastModified?: number;
}

interface NormalizedBodyPayload {
  body: unknown;
  files?: Record<string, SockressUploadedFile[]>;
}

function normalizeBodyPayload(value: unknown): NormalizedBodyPayload {
  if (
    value &&
    typeof value === 'object' &&
    '__formData' in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>).__formData === 'object'
  ) {
    const form = ((value as Record<string, unknown>).__formData || {}) as SocketFormDataEnvelope;
    const files = convertSerializedFiles(form.files ?? {});
    const fields = form.fields ?? {};
    return {
      body: fields,
      files: Object.keys(files).length ? files : undefined
    };
  }
  return { body: value === undefined ? {} : value };
}

function convertSerializedFiles(
  serialized: Record<string, SerializedSocketFile[]>
): Record<string, SockressUploadedFile[]> {
  const files: Record<string, SockressUploadedFile[]> = {};
  for (const [field, entries] of Object.entries(serialized)) {
    files[field] = entries
      .filter((entry) => typeof entry.data === 'string')
      .map((entry) => ({
        fieldName: field,
        name: entry.name ?? 'file',
        type: entry.type ?? 'application/octet-stream',
        size: entry.size ?? Buffer.from(entry.data, 'base64').length,
        buffer: Buffer.from(entry.data, 'base64'),
        lastModified: entry.lastModified
      }));
  }
  return files;
}

function pickPrimaryFile(files?: Record<string, SockressUploadedFile[]>): SockressUploadedFile | undefined {
  if (!files) {
    return undefined;
  }
  const firstKey = Object.keys(files)[0];
  if (!firstKey) return undefined;
  const list = files[firstKey];
  if (!Array.isArray(list) || !list.length) return undefined;
  return list[0];
}

export function createUploader(options?: SockressUploaderOptions): SockressUploader {
  // Dynamically require multer - it's an optional peer dependency
  let multer: any;
  try {
    multer = require('multer');
  } catch (err) {
    throw new Error(
      'File upload support requires the "multer" package. ' +
      'Install it with: npm install multer\n' +
      'Multer is an optional peer dependency to keep Sockress lightweight for users who don\'t need file uploads.'
    );
  }
  
  const storage = multer.memoryStorage();
  const multerInstance = multer({
    storage,
    limits: options?.limits
  });
  const resolvedDest = options?.dest ? path.resolve(options.dest) : undefined;
  const wrap =
    (factory: (...args: any[]) => ReturnType<Multer['single']>) =>
    (...args: any[]): SockressHandler => {
      const middleware = factory(...args);
      return (req, res, next) => {
        if (req.type === 'socket') {
          if (!resolvedDest || !req.files) {
            if (!req.file) {
              req.file = pickPrimaryFile(req.files);
            }
            next();
            return;
          }
          persistFilesToDisk(req.files, resolvedDest, options?.preserveFilename)
            .then(() => {
              if (!req.file) {
                req.file = pickPrimaryFile(req.files);
              }
              next();
            })
            .catch(next);
          return;
        }
        if (!req.raw || !res.raw) {
          next(new Error('Uploads require an HTTP request'));
          return;
        }
        middleware(req.raw as any, res.raw as any, (err?: any) => {
          if (err) {
            next(err);
            return;
          }
          const normalized = normalizeMulterOutput(req.raw as any);
          req.body = mergeBodies(req.body, normalized.fields);
          req.files = normalized.files;
          req.file = normalized.file;
          if (!resolvedDest || !req.files) {
            next();
            return;
          }
          persistFilesToDisk(req.files, resolvedDest, options?.preserveFilename)
            .then(() => next())
            .catch(next);
        });
      };
    };
  return {
    single: (field) => wrap(multerInstance.single.bind(multerInstance))(field),
    array: (field, maxCount) => wrap(multerInstance.array.bind(multerInstance))(field, maxCount),
    fields: (defs) => wrap(multerInstance.fields.bind(multerInstance))(defs),
    any: () => wrap(multerInstance.any.bind(multerInstance))()
  };
}

export function serveStatic(root: string, options?: StaticOptions): SockressHandler {
  const resolvedRoot = path.resolve(root);
  const stripPrefix = options?.stripPrefix ? ensureLeadingSlash(options.stripPrefix) : '';
  const indexFile = options?.index ?? 'index.html';
  const maxAge = options?.maxAge ?? 0;
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    let relativePath = req.path || '/';
    if (stripPrefix && relativePath.startsWith(stripPrefix)) {
      relativePath = relativePath.slice(stripPrefix.length) || '/';
    }
    const sanitized = sanitizeRelativePath(relativePath);
    let target = path.join(resolvedRoot, sanitized);
    try {
      let stats = await fsp.stat(target);
      if (stats.isDirectory()) {
        target = path.join(target, indexFile);
        stats = await fsp.stat(target);
      }
      const buffer = await fsp.readFile(target);
      res.set('cache-control', `public, max-age=${Math.floor(maxAge / 1000)}`);
      res.set('content-length', stats.size.toString());
      res.set('content-type', mimeFromExtension(path.extname(target)));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.send(buffer);
    } catch {
      next();
    }
  };
}

function mergeBodies(body: unknown, nextBody: Record<string, unknown>): Record<string, unknown> {
  const current = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return { ...current, ...nextBody };
}

function normalizeMulterOutput(req: any): {
  file?: SockressUploadedFile;
  files?: Record<string, SockressUploadedFile[]>;
  fields: Record<string, unknown>;
} {
  const files: Record<string, SockressUploadedFile[]> = {};
  const pushFile = (file: any) => {
    if (!file) return;
    const normalized: SockressUploadedFile = {
      fieldName: file.fieldname || file.name || 'file',
      name: file.originalname || file.filename || file.fieldname || 'file',
      type: file.mimetype || 'application/octet-stream',
      size: file.size ?? (file.buffer ? file.buffer.length : 0),
      buffer: file.buffer ?? Buffer.alloc(0),
      lastModified: file.lastModified
    };
    if (!files[normalized.fieldName]) {
      files[normalized.fieldName] = [];
    }
    files[normalized.fieldName].push(normalized);
  };
  if (req.file) {
    pushFile(req.file);
  }
  if (Array.isArray(req.files)) {
    req.files.forEach(pushFile);
  } else if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach((entry: any) => {
      if (Array.isArray(entry)) {
        entry.forEach(pushFile);
      } else {
        pushFile(entry);
      }
    });
  }
  return {
    file: pickPrimaryFile(files),
    files: Object.keys(files).length ? files : undefined,
    fields: req.body ?? {}
  };
}

async function persistFilesToDisk(
  files: Record<string, SockressUploadedFile[]>,
  dest: string,
  preserveFilename?: boolean
): Promise<void> {
  if (!Object.keys(files).length) return;
  await fsp.mkdir(dest, { recursive: true });
  for (const list of Object.values(files)) {
    for (const file of list) {
      const filename = preserveFilename ? sanitizeFilename(file.name) : `${Date.now()}-${generateId(8)}${path.extname(file.name || '')}`;
      const target = path.join(dest, filename);
      await fsp.writeFile(target, file.buffer);
      file.path = target;
    }
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function sanitizeRelativePath(requestPath: string): string {
  const normalized = path.normalize(requestPath);
  if (normalized.startsWith('..')) {
    return normalized.replace(/^(\.\.(\/|\\|$))+/, '');
  }
  return normalized;
}

function ensureLeadingSlash(value: string): string {
  if (!value.startsWith('/')) {
    return `/${value}`;
  }
  return value;
}

function mimeFromExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const headerKey = key.toLowerCase();
    normalized[headerKey] = Array.isArray(value) ? value.map((entry) => String(entry)) : String(value);
  }
  return normalized;
}

function enhanceAddressInfo(info: AddressInfo, preferredHost?: string): SockressAddress {
  const hostname = normalizeHostname(preferredHost ?? info.address);
  return {
    ...info,
    hostname,
    url: `http://${hostname}:${info.port}`
  };
}

function normalizeHostname(host?: string): string {
  if (!host) return 'localhost';
  const lowered = host.toLowerCase();
  if (lowered === '::' || lowered === '::1' || lowered === '0.0.0.0') {
    return 'localhost';
  }
  return host;
}

function extractSubdomains(hostname: string): string[] {
  const parts = hostname.split('.');
  if (parts.length <= 2) return [];
  return parts.slice(0, -2);
}

function getStatusText(code: number): string {
  const statusTexts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
  };
  return statusTexts[code] || 'Unknown';
}

