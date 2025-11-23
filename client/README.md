# Sockress Client SDK

[`sockress-client`](https://www.npmjs.com/package/sockress-client) is the companion SDK for Sockress-powered backends. It automatically prefers the WebSocket transport (sharing the same request/response semantics as HTTP) and silently falls back to `fetch` when a socket is unavailable. Multipart uploads (`FormData`) are serialized over the wire, so you can use a single API surface for avatars, profile forms, and realtime commands.

**Created by [Also Coder](https://alsocoder.com) · GitHub [@alsocoders](https://github.com/alsocoders)**

---

## Features

- Socket-first requests with automatic HTTP fallback
- `FormData`, `Blob`, and JSON serialization handled automatically
- Familiar API: `api.request()`, `api.get()`, `api.post()`, `api.put()`, `api.patch()`, `api.delete()`
- Built-in event emitters for `open`, `close`, `error`, and `reconnect`
- Works in browsers and Node.js (inject custom `fetch` / `wsFactory`)
- Automatic cookie handling (browser only)
- Request queuing when socket is not yet connected
- Automatic reconnection with exponential backoff

---

## Installation

```bash
npm install sockress-client
```

Sockress Client supports both ESM and CommonJS:

```ts
// ESM
import { sockressClient } from 'sockress-client';

// CommonJS
const { sockressClient } = require('sockress-client');
```

---

## Quick Start

```ts
import { sockressClient } from 'sockress-client';

const api = sockressClient({
  baseUrl: 'http://localhost:5051',
  autoConnect: true,
  preferSocket: true
});

// GET request
const users = await api.get('/api/users');
console.log(users.body);

// POST request
const response = await api.post('/api/auth/login', {
  body: { email: 'user@example.com', password: 'secret' }
});
console.log(response.body.token);
```

---

## API Methods

### `api.request(options)`

Make a request with full control:

```ts
const response = await api.request({
  path: '/api/users',
  method: 'GET',
  headers: { 'Authorization': 'Bearer token' },
  query: { page: 1, limit: 10 },
  body: { name: 'John' },
  timeout: 5000,
  signal: abortController.signal,
  disableHttpFallback: false
});
```

### `api.get(path, options?)`

```ts
const response = await api.get('/api/users', {
  query: { page: 1 },
  headers: { 'Authorization': 'Bearer token' }
});
```

### `api.post(path, options?)`

```ts
const response = await api.post('/api/users', {
  body: { name: 'John', email: 'john@example.com' }
});
```

### `api.put(path, options?)`

```ts
const response = await api.put('/api/users/123', {
  body: { name: 'Jane' }
});
```

### `api.patch(path, options?)`

```ts
const response = await api.patch('/api/users/123', {
  body: { email: 'jane@example.com' }
});
```

### `api.delete(path, options?)`

```ts
const response = await api.delete('/api/users/123');
```

---

## Response Object

All methods return a `SockressClientResponse`:

```ts
interface SockressClientResponse<T> {
  status: number;           // HTTP status code
  ok: boolean;              // true if status is 200-299
  headers: Record<string, string>;  // response headers
  body: T;                  // parsed response body
  json: <R = T>() => R;    // get body as JSON (type-safe)
  text: () => string;       // get body as string
  raw: () => T;             // get raw body
}
```

Example:

```ts
const response = await api.get('/api/users');
console.log(response.status);  // 200
console.log(response.ok);      // true
console.log(response.body);    // parsed JSON
console.log(response.json()); // same as body
console.log(response.text());  // JSON string
```

---

## File Uploads

Upload files using `FormData`:

```ts
const formData = new FormData();
formData.append('avatar', file);
formData.append('name', 'John Doe');

const response = await api.post('/api/profile/avatar', {
  body: formData,
  headers: { 'Authorization': 'Bearer token' }
});

console.log(response.body.avatarUrl);
```

The client automatically serializes `FormData` for socket transport and uses native `FormData` for HTTP fallback.

---

## Events

Listen to socket events:

```ts
// Socket opened
api.on('open', () => {
  console.log('Socket connected');
});

// Socket closed
api.on('close', ({ code, reason }) => {
  console.log('Socket closed', code, reason);
});

// Error occurred
api.on('error', (error) => {
  console.error('Socket error:', error);
});

// Reconnection attempt
api.on('reconnect', ({ attempt }) => {
  console.log('Reconnecting, attempt:', attempt);
});
```

Remove listeners:

```ts
const unsubscribe = api.on('open', () => {
  console.log('Connected');
});

// Later
api.off('open', handler);
// or
unsubscribe();
```

---

## Configuration

Create a client with custom options:

```ts
const api = sockressClient({
  baseUrl: 'http://localhost:5051',      // required
  socketPath: '/sockress',                 // WebSocket path (default: '/sockress')
  headers: { 'X-Custom': 'value' },       // default headers
  timeout: 15_000,                         // request timeout in ms (default: 15000)
  reconnectInterval: 1_000,                // initial reconnect delay (default: 1000)
  maxReconnectInterval: 15_000,            // max reconnect delay (default: 15000)
  autoConnect: true,                       // auto-connect on creation (default: true)
  preferSocket: true,                      // prefer socket over HTTP (default: true)
  credentials: 'include',                  // fetch credentials (default: 'include')
  fetchImpl: fetch,                        // custom fetch implementation
  wsFactory: (url) => new WebSocket(url)   // custom WebSocket factory
});
```

---

## Node.js Usage

In Node.js, you may need to provide custom implementations:

```ts
import fetch from 'node-fetch';
import WebSocket from 'ws';

const api = sockressClient({
  baseUrl: 'https://api.example.com',
  fetchImpl: fetch as any,
  wsFactory: (url) => new WebSocket(url) as any
});
```

---

## Manual Connection Management

Control socket connection manually:

```ts
const api = sockressClient({
  baseUrl: 'http://localhost:5051',
  autoConnect: false  // don't auto-connect
});

// Connect manually
await api.connect();

// Close manually
api.close();
```

The client automatically closes the socket on process exit (Node.js) or page unload (browser).

---

## Request Options

### `path` (required)
Request path (e.g., `'/api/users'`)

### `method` (optional)
HTTP method: `'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'`, `'HEAD'`, `'OPTIONS'` (default: `'GET'`)

### `headers` (optional)
Request headers object

### `query` (optional)
Query parameters object (values can be strings, numbers, booleans, or arrays)

```ts
await api.get('/api/users', {
  query: {
    page: 1,
    limit: 10,
    tags: ['js', 'ts'],
    active: true
  }
});
```

### `body` (optional)
Request body. Can be:
- Plain object (serialized as JSON)
- `FormData` (for file uploads)
- `Blob` or `ArrayBuffer`
- `URLSearchParams`
- String

### `timeout` (optional)
Request timeout in milliseconds (overrides default)

### `signal` (optional)
`AbortSignal` for canceling requests

### `disableHttpFallback` (optional)
If `true`, throws an error if socket is unavailable instead of falling back to HTTP (default: `false`)

---

## Error Handling

Handle errors with try/catch:

```ts
try {
  const response = await api.post('/api/users', {
    body: { name: 'John' }
  });
  console.log(response.body);
} catch (error) {
  console.error('Request failed:', error);
}
```

---

## TypeScript Support

Sockress Client is written in TypeScript and provides full type safety:

```ts
interface User {
  id: number;
  name: string;
  email: string;
}

const response = await api.get<User[]>('/api/users');
const users: User[] = response.body;
```

---

## Links

- Website: [https://alsocoder.com](https://alsocoder.com)
- GitHub: [https://github.com/alsocoders/sockress](https://github.com/alsocoders/sockress)
- Issues: [https://github.com/alsocoders/sockress/issues](https://github.com/alsocoders/sockress/issues)

PRs and feedback welcome!
