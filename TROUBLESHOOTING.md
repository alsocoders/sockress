# Troubleshooting WebSocket Connection Issues

## Common Issues and Solutions

### 1. WebSocket Connection Failed (Error Code 1006)

**Error:** `WebSocket connection to 'wss://your-domain.com/sockress' failed` with code `1006`

**Error Code 1006 Meaning:** "Abnormal Closure" - The connection was closed without a proper close frame. This usually means:
- Server rejected the connection (CORS, authentication, etc.)
- Network/firewall blocked the connection
- Reverse proxy not configured for WebSocket upgrades
- Server crashed or is not running

**Possible Causes:**

#### A. CORS Origin Not Allowed

The server checks the `Origin` header when accepting WebSocket connections. If your client's origin is not in the allowed list, the connection will be rejected.

**Solution:** Update your server CORS configuration to include your client's origin:

```js
import { sockress } from 'sockress';

const app = sockress({
  cors: {
    // Include your client domain(s) here
    origin: [
      'https://your-client-domain.com',
      'https://www.your-client-domain.com',
      'http://localhost:5173', // For development
      'http://localhost:3000'  // For development
    ],
    credentials: true
  }
});
```

**Important:** Make sure to include:
- The exact protocol (`http://` or `https://`)
- The exact domain (with or without `www`)
- The port number if using a non-standard port

#### B. Apache Reverse Proxy Not Configured for WebSocket

**This is the most common issue in production!** If you're using Apache as a reverse proxy, you MUST configure it for WebSocket upgrades.

**Working Apache Configuration (aaPanel/Production):**

```apache
<VirtualHost *:80>
    ServerAdmin admin@chat_server
    DocumentRoot "/www/wwwroot/chat.alsocoder.com/server/"
    ServerName chat-server.alsocoder.com
    ErrorLog "/www/wwwlogs/chat_server-error_log"
    CustomLog "/www/wwwlogs/chat_server-access_log" combined
    
    # Redirect HTTP → HTTPS
    RewriteEngine On
    RewriteRule ^(.*)$ https://chat-server.alsocoder.com$1 [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerAdmin admin@chat_server
    DocumentRoot "/www/wwwroot/chat.alsocoder.com/server/"
    ServerName chat-server.alsocoder.com
    ErrorLog "/www/wwwlogs/chat_server-error_log"
    CustomLog "/www/wwwlogs/chat_server-access_log" combined
    
    SSLEngine On
    SSLCertificateFile /www/server/panel/vhost/cert/chat_server/fullchain.pem
    SSLCertificateKeyFile /www/server/panel/vhost/cert/chat_server/privkey.pem
    SSLProxyEngine On
    
    # -------------------------------
    # WebSocket support for Sockress
    # -------------------------------
    ProxyPass "/sockress" "ws://127.0.0.1:5001/sockress"
    ProxyPassReverse "/sockress" "ws://127.0.0.1:5001/sockress"
    
    # Handle WebSocket Upgrade headers
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/sockress(.*) ws://127.0.0.1:5001/sockress$1 [P,L]
    
    # -------------------------------
    # General Proxy for Node backend
    # -------------------------------
    ProxyPass "/" "http://127.0.0.1:5001/"
    ProxyPassReverse "/" "http://127.0.0.1:5001/"
</VirtualHost>
```

**Key Points:**
- Use `ws://` protocol for WebSocket ProxyPass (not `http://`)
- WebSocket ProxyPass must be BEFORE general ProxyPass
- RewriteEngine handles the Upgrade header
- Replace `5001` with your actual Node.js backend port
- Replace `chat-server.alsocoder.com` with your domain

**Required Apache Modules:**
- `mod_proxy`
- `mod_proxy_http`
- `mod_proxy_wstunnel` (for WebSocket)
- `mod_rewrite`

**Check if modules are enabled:**
```bash
apache2ctl -M | grep proxy
# OR
httpd -M | grep proxy
```

#### C. WebSocket Path Mismatch

The default WebSocket path is `/sockress`. Make sure your client and server use the same path.

**Server:**
```js
const app = sockress({
  socket: {
    path: '/sockress' // Default, can be customized
  }
});
```

**Client:**
```js
const client = sockressClient({
  baseUrl: 'https://your-server.com',
  socketPath: '/sockress' // Must match server path
});
```

#### D. SSL/TLS Certificate Issues

If using `wss://`, ensure:
- Your server has a valid SSL certificate
- The certificate is not expired
- The certificate matches your domain

#### E. Server Not Running or Not Listening

Check that:
- The server is actually running
- The server is listening on the correct port
- Firewall rules allow WebSocket connections
- No reverse proxy (nginx, etc.) is blocking WebSocket upgrades

### 2. Connection Works But Messages Don't Arrive

**Possible Causes:**

#### A. Connection Not Registered

Make sure you're calling `client.connect()` before sending messages:

```js
const client = sockressClient({
  baseUrl: 'https://your-server.com',
  autoConnect: true // Or manually call client.connect()
});

await client.connect(); // If autoConnect is false
```

#### B. CORS Headers Missing

Ensure your server includes proper CORS headers for WebSocket responses.

### 3. Production Server Configuration

**Setup:** Frontend (React) on Apache + Backend (Node.js) on separate port

**Architecture:**
```
Browser → Apache (Frontend) → Node.js Backend (Port 5001)
         ↓
    React Build (Static files)
         ↓
    WebSocket Proxy → Node.js (wss://chat-server.alsocoder.com/sockress)
```

**Important:** Apache must proxy WebSocket requests to your Node.js backend!

### 4. Debugging Steps for Error 1006

1. **Check Server Logs:**
   ```bash
   # On your production server, check logs
   tail -f /var/log/your-app.log
   # OR if using PM2
   pm2 logs
   ```
   - Look for WebSocket upgrade requests
   - Check for CORS rejection messages (should show warning in dev mode)
   - Verify the server is receiving connection attempts
   - Check for any error messages

2. **Test WebSocket Connection Directly:**
   ```bash
   # Using wscat (install: npm install -g wscat)
   wscat -c wss://chat-server.alsocoder.com/sockress
   
   # OR using curl
   curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: test" \
        https://chat-server.alsocoder.com/sockress
   ```

3. **Check if Server is Running:**
   ```bash
   # SSH into your server and check
   ps aux | grep node
   netstat -tulpn | grep :5001  # or your port
   
   # Test HTTP endpoint
   curl https://chat-server.alsocoder.com/health
   ```

4. **Verify CORS Configuration:**
   - Check your server code has the correct origin in CORS config
   - Make sure it includes your client domain (exact match required)
   - Example: If client is `https://chat.alsocoder.com`, server must have it in origin list

5. **Check Apache Logs:**
   ```bash
   # Apache error log
   tail -f /var/log/apache2/error.log
   # OR for aaPanel
   tail -f /www/wwwlogs/chat_server-error_log
   
   # Apache access log
   tail -f /var/log/apache2/access.log
   # OR for aaPanel
   tail -f /www/wwwlogs/chat_server-access_log
   ```

6. **Check Browser Console:**
   - Look for WebSocket connection errors
   - Check the Network tab for WebSocket connection attempts
   - Verify the WebSocket URL is correct

7. **Test Connection:**
   ```js
   const client = sockressClient({
     baseUrl: 'https://your-server.com'
   });
   
   client.on('error', (error) => {
     console.error('Connection error:', error);
   });
   
   client.on('open', () => {
     console.log('Connected successfully!');
   });
   
   client.on('close', (details) => {
     console.log('Connection closed:', details);
   });
   ```

8. **Verify Server Configuration:**
   ```js
   app.listen(5001, '0.0.0.0', (err, address) => {
     if (err) {
       console.error('Server error:', err);
       return;
     }
     console.log(`Server running at ${address.url}`);
     console.log(`WebSocket available at ws://${address.hostname}:${address.port}/sockress`);
   });
   ```

### 5. Complete Production Setup (Apache + Node.js)

**Backend Server (Node.js) - Running on port 5001:**

```js
import { sockress } from 'sockress';
import { sockressChatServer } from 'sockress-chat';

const app = sockress({
  cors: {
    // Add all your client domains here (where React app is hosted)
    origin: [
      'https://chat.alsocoder.com',        // Your React app domain
      'https://chat-server.alsocoder.com', // If same domain
      'https://www.alsocoder.com',
      'http://localhost:5173',            // For development
      'http://localhost:3000'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id', 'x-username']
  },
  socket: {
    path: '/sockress', // Make sure this matches client
    heartbeatInterval: 30000,
    idleTimeout: 120000
  }
});

// Your routes here...
const chatServer = sockressChatServer({
  pathPrefix: '/api/chat',
  // ... your chat server config
});
chatServer.setupRoutes(app);

// IMPORTANT: Listen on 0.0.0.0, not localhost, so Apache can reach it
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', (err, address) => {
  if (err) {
    console.error('Server error:', err);
    return;
  }
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}/sockress`);
  console.log(`💬 Chat API available at http://localhost:${PORT}/api/chat`);
});
```

**Frontend Client Configuration:**

```js
import { sockressClient } from 'sockress-client';

// Use the same domain as your React app (Apache will proxy to Node.js)
const client = sockressClient({
  baseUrl: 'https://chat-server.alsocoder.com', // Same domain, Apache proxies
  socketPath: '/sockress',
  autoConnect: true,
  preferSocket: true
});
```

### 6. Still Having Issues?

#### Quick Checklist for Error 1006:

1. ✅ **Server is running** - Check `ps aux | grep node` or `pm2 list`
2. ✅ **CORS includes client domain** - Exact match required (protocol + domain + port)
3. ✅ **Apache configured for WebSocket** - Must have WebSocket ProxyPass with `ws://` protocol
4. ✅ **SSL certificate valid** - Check with `openssl s_client -connect chat-server.alsocoder.com:443`
5. ✅ **Firewall allows WebSocket** - Port 443 (wss) or 80 (ws) should be open
6. ✅ **Server logs show connection attempts** - If no logs, connection isn't reaching server

#### Common Production Issues:

**Issue:** Apache not forwarding WebSocket upgrades
**Solution:** Use the working Apache configuration above with `ws://` protocol in ProxyPass

**Issue:** CORS origin mismatch
**Solution:** Add exact client URL to server CORS origin array:
```js
origin: [
  'https://your-client-domain.com',  // Exact match required
  'https://www.your-client-domain.com'  // Include www version if used
]
```

**Issue:** Server not listening on correct interface
**Solution:** Make sure server listens on `0.0.0.0` not just `localhost`:
```js
app.listen(5001, '0.0.0.0', (err, address) => {
  // Server accessible from outside
});
```

**Issue:** SSL certificate problem
**Solution:** Verify certificate is valid and not expired:
```bash
openssl s_client -connect chat-server.alsocoder.com:443 -servername chat-server.alsocoder.com
```

## License

PROPRIETARY - See [LICENSE](./LICENSE) for details.

## Support

For issues and questions, please visit: https://github.com/alsocoders/sockress/issues

