# Sockress Chat

**Chat and room management for Sockress - Create rooms, join/leave, and send messages seamlessly.**

**Created by [Also Coder](https://alsocoder.com) · GitHub [@alsocoders](https://github.com/alsocoders)**

---

## Overview

Sockress Chat is an optional package that adds chat and room management capabilities to your Sockress application. It provides a simple API for creating rooms, joining/leaving rooms, and sending messages, all built on top of Sockress's WebSocket infrastructure.

**Features:**
- 🏠 Room management (create, join, leave, delete, list)
- 💬 Real-time messaging within rooms
- 👥 User tracking and member management
- 🔒 Private room support
- 📊 Room capacity limits
- ⚡ Built on Sockress WebSocket transport
- 🔄 Automatic connection management and reconnection handling
- ✅ Reliable message delivery with connection registration on join

---

## Installation

```bash
npm install sockress-chat
```

Sockress Chat requires `sockress` (server) and `sockress-client` (client) as dependencies:

```bash
npm install sockress sockress-client
```

---

## Server Setup

### Basic Usage

```ts
import { sockress } from 'sockress';
import { sockressChatServer } from 'sockress-chat';

const app = sockress();

// Create chat server
const chatServer = sockressChatServer({
  pathPrefix: '/api/chat', // Optional, defaults to '/api/chat'
  getUserInfo: (req) => {
    // Extract user info from request (e.g., from session, JWT, etc.)
    return {
      userId: req.context?.userId || req.ip,
      username: req.context?.username
    };
  }
});

// Setup chat routes
chatServer.setupRoutes(app);

app.listen(3000, (err, address) => {
  if (err) {
    console.error('Server error:', err);
    return;
  }
  console.log(`Server running at ${address.url}`);
});
```

### With Authentication

```ts
import { sockress } from 'sockress';
import { sockressChatServer } from 'sockress-chat';

const app = sockress({
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true
  }
});

// Middleware to extract user info from query, headers, or body
app.use((req, res, next) => {
  // Use req.get() for case-insensitive header lookup
  let userId = req.get('x-user-id') || req.query.userId;
  let username = req.get('x-username') || req.query.username;

  // For POST requests, also check body
  if ((!userId || !username) && req.body && typeof req.body === 'object') {
    userId = userId || req.body.userId;
    username = username || req.body.username;
  }

  // Only generate fallback if BOTH are missing (user not logged in)
  if (!userId && !username) {
    userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    username = `User_${Math.floor(Math.random() * 1000)}`;
  } else {
    // If one is missing, use the other
    if (!userId && username) {
      userId = username;
    }
    if (!username && userId) {
      username = userId;
    }
  }

  req.context = {
    userId,
    username
  };
  next();
});

// Create chat server
const chatServer = sockressChatServer({
  pathPrefix: '/api/chat',
  getUserInfo: (req) => {
    return req.context ? {
      userId: req.context.userId,
      username: req.context.username
    } : null;
  },
  onMessage: (message) => {
    console.log(`[${message.roomId}] ${message.username || message.userId}: ${message.message}`);
  },
  onRoomCreated: (room) => {
    console.log(`Room created: ${room.name} (${room.id})`);
  },
  onUserJoin: (roomId, userId) => {
    console.log(`User ${userId} joined room ${roomId}`);
  },
  onUserLeave: (roomId, userId) => {
    console.log(`User ${userId} left room ${roomId}`);
  }
});

// Setup chat routes
chatServer.setupRoutes(app);

// Get user's joined rooms
app.get('/api/chat/my-rooms', (req, res) => {
  try {
    const userInfo = req.context;
    if (!userInfo || !userInfo.userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const userRooms = chatServer.getUserRooms(userInfo.userId);
    const rooms = userRooms.map(roomId => {
      const room = chatServer.getRoom(roomId);
      return room ? {
        id: room.id,
        name: room.name,
        memberCount: room.members.size,
        maxMembers: room.maxMembers,
        isPrivate: room.isPrivate,
        createdAt: room.createdAt
      } : null;
    }).filter(Boolean);

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user rooms' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, (err, address) => {
  if (err) {
    console.error('Server error:', err);
    return;
  }
  console.log(`🚀 Chat Server running at ${address.url}`);
  console.log(`📡 WebSocket available at ws://localhost:${PORT}/sockress`);
  console.log(`💬 Chat API available at http://localhost:${PORT}/api/chat`);
});
```

### API Endpoints

The chat server creates the following endpoints:

- `POST /api/chat/rooms` - Create a new room
- `GET /api/chat/rooms` - List all public rooms
- `GET /api/chat/rooms/:roomId` - Get room details
- `POST /api/chat/rooms/:roomId/join` - Join a room (automatically registers WebSocket connection)
- `POST /api/chat/rooms/:roomId/leave` - Leave a room
- `POST /api/chat/rooms/:roomId/messages` - Send a message to a room
- `DELETE /api/chat/rooms/:roomId` - Delete a room (creator only)
- `GET /api/chat/my-rooms` - Get all rooms the current user has joined (if implemented in your server)

---

## Client Setup

### Basic Usage

```ts
import { sockressClient } from 'sockress-client';
import { sockressChatClient } from 'sockress-chat';

// Create Sockress client
const client = sockressClient({
  baseUrl: 'http://localhost:3000'
});

// Create chat client
const chat = sockressChatClient({
  client,
  userId: 'user123',
  username: 'john_doe',
  onMessage: (message) => {
    console.log(`New message: ${message.message}`);
  }
});

// Connect to server
await client.connect();

// Create a room
const room = await chat.createRoom({
  name: 'General Chat',
  maxMembers: 50
});

// Join the room
await chat.joinRoom(room.id);

// Send a message
await chat.sendMessage(room.id, 'Hello, everyone!');

// List all rooms
const rooms = await chat.listRooms();
console.log('Available rooms:', rooms);
```

### Complete Client Example with Message Deduplication

```js
import { sockressClient } from 'sockress-client';
import { sockressChatClient } from 'sockress-chat';

const BASE_URL = 'http://localhost:3000';

// Store current user info for headers
let currentUserId = null;
let currentUsername = null;

// Function to get current headers
function getCurrentHeaders() {
  const headers = {};
  if (currentUserId) {
    headers['x-user-id'] = currentUserId;
  }
  if (currentUsername) {
    headers['x-username'] = currentUsername;
  }
  return headers;
}

// Create Sockress client
export const client = sockressClient({
  baseUrl: BASE_URL,
  autoConnect: true,
  preferSocket: true
});

// Chat client will be initialized after user login
let chatClient = null;
let messageHandlers = new Map();
// Track processed message IDs to prevent duplicates
let processedMessages = new Set();

export function initializeChat(userId, username) {
  // Store user info for headers
  currentUserId = userId;
  currentUsername = username;

  // If chat client already exists, don't recreate it (prevent duplicate handlers)
  if (chatClient) {
    return chatClient;
  }

  // Create new chat client
  chatClient = sockressChatClient({
    client,
    userId,
    username,
    onMessage: (message) => {
      // Deduplicate: Check if we've already processed this message
      if (processedMessages.has(message.id)) {
        return;
      }
      
      // Mark message as processed
      processedMessages.add(message.id);
      
      // Clean up old message IDs (keep last 1000)
      if (processedMessages.size > 1000) {
        const firstId = processedMessages.values().next().value;
        processedMessages.delete(firstId);
      }
      
      // Handle incoming messages for all registered handlers
      const handlers = messageHandlers.get(message.roomId) || [];
      handlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          console.error('Message handler error:', error);
        }
      });
    },
    onJoin: (roomId, userId) => {
      // Optional: Handle join events
    },
    onLeave: (roomId, userId) => {
      // Optional: Handle leave events
    }
  });

  return chatClient;
}

export function getChatClient() {
  return chatClient;
}

export async function connect() {
  await client.connect();
}

// Register message handler for a specific room
export function registerMessageHandler(roomId, handler) {
  if (!messageHandlers.has(roomId)) {
    messageHandlers.set(roomId, []);
  }
  messageHandlers.get(roomId).push(handler);

  // Return cleanup function
  return () => {
    const handlers = messageHandlers.get(roomId);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
      if (handlers.length === 0) {
        messageHandlers.delete(roomId);
      }
    }
  };
}

// Get user's joined rooms
export async function getMyRooms() {
  const response = await client.get('/api/chat/my-rooms', {
    headers: getCurrentHeaders()
  });
  const result = await response.json();
  return result.rooms || [];
}

// Wrapper to add headers to chat client requests
export function getChatClientWithHeaders() {
  const chatClient = getChatClient();
  if (!chatClient) return null;

  return {
    ...chatClient,
    createRoom: async (data) => {
      const response = await client.post('/api/chat/rooms', {
        headers: getCurrentHeaders(),
        body: data
      });
      const result = await response.json();
      return result.room;
    },
    listRooms: async () => {
      const response = await client.get('/api/chat/rooms', {
        headers: getCurrentHeaders()
      });
      const result = await response.json();
      return result.rooms || [];
    },
    joinRoom: async (roomId) => {
      const response = await client.post(`/api/chat/rooms/${roomId}/join`, {
        headers: getCurrentHeaders(),
        body: {}
      });
      const result = await response.json();
      return result.room;
    },
    sendMessage: async (roomId, message) => {
      const response = await client.post(`/api/chat/rooms/${roomId}/messages`, {
        headers: getCurrentHeaders(),
        body: {
          roomId,
          message,
          username: currentUsername
        }
      });
      const result = await response.json();
      return result.message;
    },
    leaveRoom: async (roomId) => {
      await client.post(`/api/chat/rooms/${roomId}/leave`, {
        headers: getCurrentHeaders(),
        body: {}
      });
    }
  };
}
```

### React Example with Message Handlers

```tsx
import { useEffect, useState, useRef } from 'react';
import { initializeChat, registerMessageHandler, getChatClientWithHeaders } from './api/client';
import type { ChatMessage } from 'sockress-chat';

function ChatRoom({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const chatClient = getChatClientWithHeaders();
    if (!chatClient) return;

    // Register message handler for this room
    const cleanup = registerMessageHandler(roomId, (message: ChatMessage) => {
      setMessages(prev => [...prev, message]);
    });

    cleanupRef.current = cleanup;

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [roomId]);

  const handleSendMessage = async (text: string) => {
    const chatClient = getChatClientWithHeaders();
    if (chatClient) {
      await chatClient.sendMessage(roomId, text);
    }
  };

  return (
    <div>
      <h3>Messages</h3>
      {messages.map(msg => (
        <div key={msg.id}>
          <strong>{msg.username}:</strong> {msg.message}
        </div>
      ))}
      <input
        onKeyPress={(e) => {
          if (e.key === 'Enter') {
            handleSendMessage(e.currentTarget.value);
            e.currentTarget.value = '';
          }
        }}
      />
    </div>
  );
}
```

---

## Types

```ts
interface RoomInfo {
  id: string;
  name: string;
  memberCount: number;
  maxMembers?: number;
  isPrivate: boolean;
  createdAt: number;
}

interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username?: string;
  message: string;
  timestamp: number;
  type?: 'message' | 'system' | 'join' | 'leave';
}

interface CreateRoomRequest {
  name: string;
  maxMembers?: number;
  isPrivate?: boolean;
}
```

---

## Advanced Usage

### Custom Event Handlers

```ts
const chatServer = sockressChatServer({
  onMessage: (message) => {
    // Log to database, send notifications, etc.
    console.log('Message received:', message);
  },
  onRoomCreated: (room) => {
    console.log('Room created:', room);
  },
  onRoomDeleted: (roomId) => {
    console.log('Room deleted:', roomId);
  },
  onUserJoin: (roomId, userId) => {
    console.log(`User ${userId} joined room ${roomId}`);
  },
  onUserLeave: (roomId, userId) => {
    console.log(`User ${userId} left room ${roomId}`);
  }
});
```

### Room Management

```ts
// Get room information
const room = chatServer.getRoom('room-id');

// Get all rooms
const allRooms = chatServer.getAllRooms();

// Get user's rooms
const userRooms = chatServer.getUserRooms('user-id');
```

### Connection Handling

The chat server automatically manages WebSocket connections:

- **On Join**: When a user joins a room, their WebSocket connection is automatically registered for that room
- **On Message**: When sending a message, the sender's connection is registered/updated
- **Broadcasting**: Messages are only sent to connections that are ready (WebSocket state = OPEN)
- **Cleanup**: Stale or closed connections are automatically removed from the connection map

This ensures reliable message delivery, even for the first message sent after joining a room.

---

## Real-time Events

Messages are broadcast to all members of a room in real-time via WebSocket. When a user joins, leaves, or sends a message, all other members receive the event automatically.

**Key Features:**
- **Reliable Message Delivery**: Connections are automatically registered when users join rooms, ensuring all messages are delivered even if sent immediately after joining
- **Automatic Reconnection**: The chat client automatically re-registers message listeners when WebSocket connections are re-established
- **Connection Management**: The server intelligently manages WebSocket connections, updating them when sockets change and cleaning up stale connections

**Note:** For receiving real-time events on the client, ensure your Sockress client is connected via WebSocket. The chat client will automatically handle message routing and event broadcasting.

---

## License

PROPRIETARY - See [LICENSE](./LICENSE) for details.

---

## Support

For issues and questions, please visit: https://github.com/alsocoders/sockress/issues

