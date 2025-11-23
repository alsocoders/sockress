import http, { IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import type { Socket } from 'net';
import { TLSSocket } from 'tls';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { CookieSerializeOptions } from 'cookie';
import { nanoid } from 'nanoid';
import multer, { Options as MulterOptions } from 'multer';
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
export type SockressErrorHandler = (err: unknown, req: SockressRequest, res: SockressResponse, next: NextFunction) => unknown;

export interface SockressOptions {
  cors?: Partial<CorsOptions>;
  socket?: Partial<SocketOptions>;
  bodyLimit?: number;
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

interface IncomingSocketMessage {
  type: 'request';
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
  query?: Record<string, string | string[]>;
  body?: unknown;
}

interface OutgoingSocketMessage {
  type: 'response' | 'error';
  id?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  message?: string;
  code?: string;
  cookies?: string[];
}

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
  private headers: Record<string, string> = {};
  private cookies: string[] = [];
  public readonly raw?: ServerResponse;

  constructor(
    private readonly mode: RequestMode,
    private readonly cors: CorsOptions,
    private readonly allowedOrigin: string
  ) {
    if (mode.kind === 'http') {
      this.raw = mode.res;
    }
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  set(field: string, value: string): this {
    this.headers[field.toLowerCase()] = value;
    return this;
  }

  append(field: string, value: string): this {
    const current = this.headers[field.toLowerCase()];
    if (current) {
      this.headers[field.toLowerCase()] = `${current}, ${value}`;
    } else {
      this.headers[field.toLowerCase()] = value;
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
    if (this.sent) {
      return this;
    }
    this.sent = true;
    if (!this.headers['content-type'] && typeof payload === 'string') {
      this.set('content-type', 'text/plain; charset=utf-8');
    }
    const headersWithCors = this.buildHeaders();
    if (this.mode.kind === 'http') {
      const res = this.mode.res;
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

  end(): this {
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

export class SockressApp {
  private middlewares: MiddlewareLayer[] = [];
  private routes: RouteLayer[] = [];
  private paramHandlers: Map<string, SockressHandler> = new Map();
  private server?: http.Server;
  private wss?: WebSocketServer;
  private heartbeatInterval?: NodeJS.Timeout;
  private shutdownRegistered = false;
  private shuttingDown = false;

  constructor(private readonly config: NormalizedOptions) {}

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
          this.middlewares.push({
            path: path === '/' ? layer.path : `${path}${layer.path === '/' ? '' : layer.path}`,
            handler: layer.handler,
            isErrorHandler: layer.isErrorHandler
          });
        }
        for (const route of routerStack.routes) {
          this.routes.push({
            method: route.method,
            matcher: buildMatcher(path === '/' ? route.matcher.raw : `${path}${route.matcher.raw}`),
            handlers: route.handlers
          });
        }
      } else {
        this.middlewares.push({
          path,
          handler: item as SockressHandler | SockressErrorHandler,
          isErrorHandler: (item as SockressHandler | SockressErrorHandler).length === 4
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

  param(name: string, handler: SockressHandler): this {
    this.paramHandlers.set(name, handler);
    return this;
  }

  route(path: string): SockressAppRoute {
    return new SockressAppRoute(this, path);
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
      if (!isOriginAllowed(origin, this.config.cors.origin)) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[Sockress] WebSocket connection rejected: origin "${origin}" not allowed. Allowed origins:`, this.config.cors.origin);
        }
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
      const cookies = req.headers.cookie ? parseCookie(req.headers.cookie) : {};
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
        nanoid(),
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
      const sockressRes = new SockressResponse({ kind: 'http', req, res }, this.config.cors, origin);
      if (sockressReq.method === 'OPTIONS') {
        sockressRes.status(204).end();
        return;
      }
      await this.runPipeline(sockressReq, sockressRes);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Internal Server Error', details: error instanceof Error ? error.message : error }));
    }
  }

  private handleSocket(socket: WebSocket & { isAlive?: boolean }, req: IncomingMessage): void {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', async (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as IncomingSocketMessage;
        if (payload.type !== 'request') {
          return socket.send(JSON.stringify({ type: 'error', message: 'Unsupported message type' }));
        }
        const path = payload.path || '/';
        const method = (payload.method || 'GET').toUpperCase() as HTTPMethod;
        const query = payload.query ?? {};
        const headers = normalizeHeaders(payload.headers ?? {});
        const cookieHeader = headers.cookie;
        const cookieString = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
        const cookies = typeof cookieString === 'string' ? parseCookie(cookieString) : {};
        const secure = isSocketEncrypted(req.socket as Socket);
        const normalizedPayload = normalizeBodyPayload(payload.body);
        const primaryFile = pickPrimaryFile(normalizedPayload.files);
        const originalUrl = payload.path || '/';
        const sockressReq = new SockressRequestImpl(
          payload.id ?? nanoid(),
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
        const sockressRes = new SockressResponse({ kind: 'socket', socket, requestId: sockressReq.id }, this.config.cors, origin);
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

  private async runPipeline(req: SockressRequest, res: SockressResponse): Promise<void> {
    const stack = this.composeStack(req, req.method);
    let idx = 0;
    const next: NextFunction = async (err?: unknown) => {
      const layer = stack[idx++];
      if (!layer) {
        if (err) {
          this.renderError(err, req, res);
        } else if (!res.isSent()) {
          res.status(404).json({ error: 'Not Found' });
        }
        return;
      }
      const handler = layer.handler;
      const isErrorHandler = layer.isErrorHandler;
      try {
        if (err) {
          if (isErrorHandler) {
            await (handler as SockressErrorHandler)(err, req, res, next);
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
    const stack: PipelineLayer[] = [];
    for (const layer of this.middlewares) {
      if (matchesPrefix(layer.path, path)) {
        stack.push({
          handler: layer.handler,
          isErrorHandler: layer.isErrorHandler
        });
      }
    }
    for (const route of this.routes) {
      if (route.method !== method && route.method !== 'ALL') {
        continue;
      }
      const match = route.matcher.match(path);
      if (!match) continue;
      req.params = { ...match.params };
      for (const [paramName, paramValue] of Object.entries(match.params)) {
        const paramHandler = this.paramHandlers.get(paramName);
        if (paramHandler) {
          const wrapped: SockressHandler = (request, res, next) => {
            request.params = { ...match.params };
            return paramHandler(request, res, next);
          };
          stack.push({ handler: wrapped, isErrorHandler: false });
        }
      }
      for (const handler of route.handlers) {
        const isErrorHandler = handler.length === 4;
        if (isErrorHandler) {
          const wrapped: SockressErrorHandler = (err, request, res, next) => {
            request.params = { ...match.params };
            return (handler as SockressErrorHandler)(err, request, res, next);
          };
          stack.push({ handler: wrapped, isErrorHandler: true });
        } else {
          const wrapped: SockressHandler = (request, res, next) => {
            request.params = { ...match.params };
            return (handler as SockressHandler)(request, res, next);
          };
          stack.push({ handler: wrapped, isErrorHandler: false });
        }
      }
    }
    return stack;
  }

  private renderError(err: unknown, req: SockressRequest, res: SockressResponse): void {
    if (res.isSent()) {
      return;
    }
    res.status(500).json({
      error: 'Internal Server Error',
      details: err instanceof Error ? err.message : err
    });
  }
}

export function sockress(options?: SockressOptions): SockressApp {
  return SockressApp.create(options);
}

export const createSockress = sockress;
export const Router = SockressApp.Router;

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
  return { cors, socket, bodyLimit };
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
  if (!originHeader || allowed === '*') return true;
  if (Array.isArray(allowed)) {
    return allowed.includes(originHeader);
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
      const filename = preserveFilename ? sanitizeFilename(file.name) : `${Date.now()}-${nanoid(8)}${path.extname(file.name || '')}`;
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

