# Sockress

**Socket-first Express-compatible framework with built-in WebSocket transport and optional HTTP fallback.**

**Created by [Also Coder](https://alsocoder.com) · GitHub [@alsocoders](https://github.com/alsocoders)**

---

## Overview

Sockress is a monorepo containing two packages:

- **[`sockress`](./server)** - Server-side framework (Express-compatible API)
- **[`sockress-client`](./client)** - Client-side SDK with automatic socket connection

Sockress prioritizes WebSocket connections for real-time communication, automatically falling back to HTTP when sockets aren't available. This allows a single codebase to serve both realtime and REST consumers seamlessly.

---

## Packages

### 🖥️ [sockress](./server) - Server Package

Express-compatible server framework with built-in WebSocket support.

**Installation:**
```bash
npm install sockress
```

**Features:**
- Express-style routing and middleware
- Router support for modular routing
- Automatic CORS handling
- Cookie parsing and setting
- File uploads (multer-compatible)
- Static file serving
- Comprehensive Express-like API (redirect, sendFile, download, accepts, is, param, etc.)
- Graceful shutdown hooks

**Quick Start:**
```ts
import { sockress } from 'sockress';

const app = sockress();

app.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

app.listen(3000, (err, address) => {
  if (err) {
    console.error('Server error:', err);
    return;
  }
  console.log(`Server running at ${address.url}`);
});
```

📖 **[Full Server Documentation](./server/README.md)**

---

### 📱 [sockress-client](./client) - Client Package

Socket-first client SDK with automatic HTTP fallback.

**Installation:**
```bash
npm install sockress-client
```

**Features:**
- Automatic WebSocket connection
- HTTP fallback when sockets unavailable
- Request queuing during connection
- FormData serialization for file uploads
- Express-like API (`get`, `post`, `put`, `patch`, `delete`)
- Automatic socket cleanup on process exit/browser unload

**Quick Start:**
```ts
import { sockressClient } from 'sockress-client';

const client = sockressClient('ws://localhost:3000');

// Works with both socket and HTTP
const response = await client.get('/ping');
console.log(response.data); // { message: 'pong' }
```

📖 **[Full Client Documentation](./client/README.md)**

---

## Monorepo Structure

```
Sockress/
├── server/          # sockress server package
│   ├── src/         # TypeScript source
│   ├── dist/        # Compiled output
│   └── package.json
├── client/          # sockress-client package
│   ├── src/         # TypeScript source
│   ├── dist/        # Compiled output
│   └── package.json
└── package.json     # Root workspace config
```

---

## Development

This is a monorepo managed with npm workspaces.

**Build all packages:**
```bash
npm run build
```

**Build individual packages:**
```bash
npm run build -w sockress
npm run build -w sockress-client
```

---

## License

PROPRIETARY - See [LICENSE](./LICENSE) file for details.

---

## Links

- **Website:** https://alsocoder.com
- **GitHub:** https://github.com/alsocoders/sockress
- **NPM Server Package:** https://www.npmjs.com/package/sockress
- **NPM Client Package:** https://www.npmjs.com/package/sockress-client

---

## Support

For issues, questions, or contributions, please visit:
- **Issues:** https://github.com/alsocoders/sockress/issues
- **Email:** hello@alsocoder.com

