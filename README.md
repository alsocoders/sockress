# Sockress Server

Sockress is a socket-first Node.js framework that mirrors the Express API while automatically upgrading compatible requests to WebSockets. HTTP clients (Postman, curl, third-party services) continue to work with zero changes, so a single codebase can serve both realtime and REST consumers.

**Created by [Also Coder](https://alsocoder.com) · GitHub [@alsocoders](https://github.com/alsocoders)**

---

## Features

- Express-style routing (`app.get`, `app.post`, `app.put`, `app.patch`, `app.delete`, `app.head`, `app.options`, `app.all`)
- **Router support** - Modular routing with `sockress.Router()`
- Unified middleware pipeline for HTTP and WebSocket transports
- Automatic CORS handling with configurable origins
- Cookie parsing and setting via `req.cookies` and `res.cookie()`
- File uploads via `createUploader()` (multer-compatible) that work on both transports
- Static file serving via `serveStatic()` helper
- Request context object (`req.context`) for passing data through middleware
- **Response helpers**: `redirect()`, `sendFile()`, `download()`, `sendStatus()`, `format()`, `location()`, `vary()`
- **Request helpers**: `accepts()`, `is()`, `param()`, plus `hostname`, `originalUrl`, `baseUrl`, `subdomains`
- **Parameter middleware** with `app.param()`
- **Chainable routes** with `app.route()`
- Graceful shutdown hooks (automatically closes on `beforeExit`, `SIGINT`, `SIGTERM`)
- Heartbeat management for long-lived WebSocket connections

---

## Installation

```bash
npm install sockress
```

Sockress supports both ESM and CommonJS:

```ts
// ESM
import { sockress, createUploader, serveStatic, Router } from 'sockress';

// CommonJS
const { sockress, createUploader, serveStatic, Router } = require('sockress');
```

---

## Quick Start

```ts
import { sockress } from 'sockress';

const app = sockress();

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.path}`);
  next();
});

app.get('/ping', (req, res) => {
  res.json({ ok: true, via: 'sockress' });
});

app.listen(5051, (err, address) => {
  if (err) throw err;
  console.log(`Sockress listening on ${address?.url}`);
});
```

---

## Routing

Sockress supports all standard HTTP methods:

```ts
app.get('/users', (req, res) => {
  res.json({ users: [] });
});

app.post('/users', (req, res) => {
  const { name, email } = req.body;
  res.json({ id: 1, name, email });
});

app.put('/users/:id', (req, res) => {
  const { id } = req.params;
  res.json({ id, updated: true });
});

app.patch('/users/:id', (req, res) => {
  res.json({ patched: true });
});

app.delete('/users/:id', (req, res) => {
  res.status(204).end();
});

app.all('/catch-all', (req, res) => {
  res.json({ method: req.method });
});
```

Route parameters are available via `req.params`:

```ts
app.get('/users/:userId/posts/:postId', (req, res) => {
  const { userId, postId } = req.params;
  res.json({ userId, postId });
});
```

### Chainable Routes

Use `app.route()` for chainable route handlers:

```ts
app.route('/users')
  .get((req, res) => {
    res.json({ users: [] });
  })
  .post((req, res) => {
    const { name } = req.body;
    res.json({ id: 1, name });
  })
  .put((req, res) => {
    res.json({ updated: true });
  });
```

---

## Router

Create modular routers for better code organization:

```ts
import { sockress, Router } from 'sockress';

const app = sockress();
const userRouter = Router();

userRouter.get('/', (req, res) => {
  res.json({ users: [] });
});

userRouter.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

userRouter.post('/', (req, res) => {
  res.json({ created: true });
});

app.use('/api/users', userRouter);
```

Routers support all the same methods as the main app:

```ts
const apiRouter = Router();

apiRouter.use((req, res, next) => {
  req.context.apiVersion = 'v1';
  next();
});

apiRouter.get('/status', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', apiRouter);
```

---

## Middleware

Middleware works the same way as Express. Use `app.use()` to register global or path-scoped middleware:

```ts
// Global middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Path-scoped middleware
app.use('/api', (req, res, next) => {
  req.context.apiVersion = 'v1';
  next();
});

// Multiple middleware
app.use('/secure', authMiddleware, validateMiddleware, handler);

// Use Router as middleware
const router = Router();
router.get('/users', getUsers);
app.use('/api', router);
```

### Parameter Middleware

Use `app.param()` to add middleware for specific route parameters:

```ts
app.param('userId', async (req, res, next) => {
  const user = await findUser(req.params.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  req.context.user = user;
  next();
});

app.get('/users/:userId', (req, res) => {
  res.json({ user: req.context.user });
});
```

### Error Handling

Error handlers have 4 parameters `(err, req, res, next)`:

```ts
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});
```

---

## Response Methods

### Basic Methods

```ts
res.status(404)              // Set status code
res.set('X-Custom', 'value') // Set header
res.append('X-Other', 'val') // Append to header
res.json({ data: 'value' })  // Send JSON
res.send('Hello')            // Send response (auto-detects type)
res.end()                    // End response
```

### Redirect

```ts
// Simple redirect (302)
res.redirect('/login');

// Redirect with status code
res.redirect(301, '/new-url');

// Or status first
res.redirect(301, '/permanent-redirect');
```

### Send File

```ts
// Send file as response
await res.sendFile('/path/to/file.pdf');

// With options
await res.sendFile('file.pdf', {
  root: '/uploads',
  headers: { 'X-Custom': 'value' }
});
```

### Download File

```ts
// Download file
await res.download('/path/to/file.pdf');

// With custom filename
await res.download('/path/to/file.pdf', 'custom-name.pdf');

// With options
await res.download('file.pdf', 'download.pdf', {
  root: '/uploads',
  headers: { 'X-Custom': 'value' }
});
```

### Send Status

```ts
// Send status code with default text
res.sendStatus(404); // Sends "Not Found"
res.sendStatus(200); // Sends "OK"
```

### Content Negotiation

```ts
res.format({
  'text/html': (req, res) => {
    res.send('<h1>HTML</h1>');
  },
  'application/json': (req, res) => {
    res.json({ format: 'json' });
  },
  'default': (req, res) => {
    res.send('Default format');
  }
}, req);
```

### Location Header

```ts
res.location('/new-path');
res.status(301).end();
```

### Vary Header

```ts
res.vary('Accept');
res.vary('User-Agent');
```

---

## Request Methods & Properties

### Request Properties

```ts
req.id          // unique request ID
req.method      // HTTP method (GET, POST, etc.)
req.path        // request path
req.query       // parsed query string (object)
req.params       // route parameters (object)
req.headers     // request headers (object)
req.body        // parsed request body
req.cookies      // parsed cookies (object)
req.file         // first uploaded file (if any)
req.files        // all uploaded files (object mapping field names to arrays)
req.type         // 'http' or 'socket'
req.ip           // client IP address
req.protocol     // 'http', 'https', 'ws', or 'wss'
req.secure       // boolean indicating if connection is secure
req.hostname     // request hostname
req.originalUrl  // original request URL
req.baseUrl      // base URL for router
req.subdomains   // array of subdomains
req.context      // plain object for passing data through middleware
req.raw          // IncomingMessage (HTTP only)
```

### Request Methods

```ts
// Get header value
const auth = req.get('authorization');

// Get route parameter
const userId = req.param('userId');
const userIdWithDefault = req.param('userId', 'default');

// Content negotiation
if (req.accepts('json')) {
  res.json({ data: 'value' });
}

const accepted = req.accepts(['json', 'html']); // returns 'json' or 'html' or false

// Content type check
if (req.is('application/json')) {
  // handle JSON
}

const isJson = req.is(['json', 'html']); // returns 'json' or 'html' or false or null
```

---

## File Uploads

Use `createUploader()` to handle file uploads. It works for both HTTP and WebSocket transports:

```ts
import { sockress, createUploader } from 'sockress';
import path from 'path';

const app = sockress();
const uploadsDir = path.join(process.cwd(), 'uploads');

const uploader = createUploader({
  dest: uploadsDir,
  preserveFilename: true,
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});

// Single file upload
app.post('/avatar', uploader.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'avatar missing' });
  }
  res.json({ path: req.file.path, name: req.file.name });
});

// Multiple files
app.post('/gallery', uploader.array('images', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'images missing' });
  }
  res.json({ count: req.files.length });
});

// Multiple fields
app.post('/documents', uploader.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'documents', maxCount: 10 }
]), (req, res) => {
  const avatar = req.files?.avatar?.[0];
  const documents = req.files?.documents || [];
  res.json({ avatar, documents: documents.length });
});

// Any files
app.post('/upload', uploader.any(), (req, res) => {
  const files = req.files || {};
  res.json({ files: Object.keys(files) });
});
```

Uploaded files are available via:
- `req.file` - first uploaded file (when using `single()`)
- `req.files` - object mapping field names to arrays of files

Each file has:
- `fieldName` - form field name
- `name` - original filename
- `type` - MIME type
- `size` - file size in bytes
- `buffer` - file contents as Buffer
- `path` - file path on disk (if `dest` was configured)
- `lastModified` - file last modified timestamp (if available)

---

## Static File Serving

Use `serveStatic()` to serve static files:

```ts
import { sockress, serveStatic } from 'sockress';
import path from 'path';

const app = sockress();
const uploadsDir = path.join(process.cwd(), 'uploads');

app.use('/uploads', serveStatic(uploadsDir, {
  stripPrefix: '/uploads',
  maxAge: 60_000, // cache for 60 seconds
  index: 'index.html' // default file for directories
}));
```

Options:
- `stripPrefix` - remove this prefix from the request path before resolving files
- `maxAge` - cache control max age in milliseconds
- `index` - default file to serve for directories (default: `'index.html'`)

You can also use the convenience method:

```ts
app.useStatic('/uploads', uploadsDir, { maxAge: 60_000 });
```

---

## Configuration

Create a Sockress app with custom options:

```ts
const app = sockress({
  cors: {
    origin: ['http://localhost:3000', 'https://example.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Custom-Header'],
    maxAge: 600
  },
  socket: {
    path: '/sockress',           // WebSocket path (default: '/sockress')
    heartbeatInterval: 30_000,    // heartbeat interval in ms (default: 30000)
    idleTimeout: 120_000          // idle timeout in ms (default: 120000)
  },
  bodyLimit: 1_000_000          // max body size in bytes (default: 1000000)
});
```

---

## Listening

Start the server with `app.listen()`:

```ts
// Simple
app.listen(5051);

// With callback
app.listen(5051, (err, address) => {
  if (err) {
    console.error('Failed to start server:', err);
    return;
  }
  console.log(`Server listening on ${address?.url}`);
});

// With host
app.listen(5051, '0.0.0.0', (err, address) => {
  if (err) throw err;
  console.log(`Server listening on ${address?.url}`);
});
```

The callback receives:
- `err` - Error if server failed to start, or `null`
- `address` - Server address info with `hostname` and `url` properties

Sockress automatically registers shutdown hooks for `beforeExit`, `SIGINT`, and `SIGTERM` to gracefully close the server.

---

## Manual Shutdown

You can manually close the server:

```ts
const server = app.listen(5051);
// ... later
await app.close();
```

---

## Complete Example

```ts
import { sockress, Router, createUploader } from 'sockress';
import path from 'path';

const app = sockress();
const uploader = createUploader({ dest: './uploads' });

// Parameter middleware
app.param('userId', async (req, res, next) => {
  const user = await findUser(req.params.userId);
  if (user) {
    req.context.user = user;
    next();
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// Router
const apiRouter = Router();
apiRouter.use((req, res, next) => {
  req.context.apiVersion = 'v1';
  next();
});

apiRouter.route('/users/:userId')
  .get((req, res) => {
    res.json({ user: req.context.user });
  })
  .put((req, res) => {
    // Update user
    res.json({ updated: true });
  });

app.use('/api', apiRouter);

// File upload
app.post('/avatar', uploader.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file' });
  }
  res.json({ path: req.file.path });
});

// Redirect
app.get('/old', (req, res) => {
  res.redirect(301, '/new');
});

// Download
app.get('/download/:file', async (req, res) => {
  await res.download(`./files/${req.params.file}`);
});

// Content negotiation
app.get('/data', (req, res) => {
  res.format({
    'text/html': (req, res) => res.send('<h1>HTML</h1>'),
    'application/json': (req, res) => res.json({ format: 'json' }),
    'default': (req, res) => res.send('Default')
  }, req);
});

app.listen(5051, (err, address) => {
  if (err) throw err;
  console.log(`Server on ${address?.url}`);
});
```

---

## Companion Client

Pair Sockress with [`sockress-client`](https://www.npmjs.com/package/sockress-client) to get automatic socket transports, FormData serialization, and seamless HTTP fallback:

```ts
import { sockressClient } from 'sockress-client';

const api = sockressClient({ baseUrl: 'http://localhost:5051' });
const response = await api.post('/api/auth/login', {
  body: { email: 'user@example.com', password: 'secret' }
});
console.log(response.body.token);
```

---

## Links

- Website: [https://alsocoder.com](https://alsocoder.com)
- GitHub: [https://github.com/alsocoders/sockress](https://github.com/alsocoders/sockress)
- Issues: [https://github.com/alsocoders/sockress/issues](https://github.com/alsocoders/sockress/issues)

PRs and feedback welcome!
