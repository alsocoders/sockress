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

const app = sockress();

// Middleware to extract user info
app.use((req, res, next) => {
  // Example: Extract from JWT or session
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    // Decode token and set user info
    req.context = {
      userId: 'user123',
      username: 'john_doe'
    };
  }
  next();
});

const chatServer = sockressChatServer({
  getUserInfo: (req) => {
    return req.context ? {
      userId: req.context.userId,
      username: req.context.username
    } : null;
  },
  onMessage: (message) => {
    console.log(`Message in room ${message.roomId}:`, message.message);
  },
  onRoomCreated: (room) => {
    console.log(`Room created: ${room.name} (${room.id})`);
  }
});

chatServer.setupRoutes(app);

app.listen(3000);
```

### API Endpoints

The chat server creates the following endpoints:

- `POST /api/chat/rooms` - Create a new room
- `GET /api/chat/rooms` - List all public rooms
- `GET /api/chat/rooms/:roomId` - Get room details
- `POST /api/chat/rooms/:roomId/join` - Join a room
- `POST /api/chat/rooms/:roomId/leave` - Leave a room
- `POST /api/chat/rooms/:roomId/messages` - Send a message to a room
- `DELETE /api/chat/rooms/:roomId` - Delete a room (creator only)

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

### React Example

```tsx
import { useEffect, useState } from 'react';
import { sockressClient } from 'sockress-client';
import { sockressChatClient } from 'sockress-chat';
import type { RoomInfo, ChatMessage } from 'sockress-chat';

function ChatApp() {
  const [chat, setChat] = useState<any>(null);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);

  useEffect(() => {
    const client = sockressClient({
      baseUrl: 'http://localhost:3000'
    });

    const chatClient = sockressChatClient({
      client,
      userId: 'user123',
      username: 'John Doe',
      onMessage: (message) => {
        if (message.roomId === currentRoom) {
          setMessages(prev => [...prev, message]);
        }
      }
    });

    client.connect().then(() => {
      setChat(chatClient);
      chatClient.listRooms().then(setRooms);
    });

    return () => {
      client.close();
    };
  }, []);

  const handleJoinRoom = async (roomId: string) => {
    if (chat) {
      await chat.joinRoom(roomId);
      setCurrentRoom(roomId);
      setMessages([]);
    }
  };

  const handleSendMessage = async (message: string) => {
    if (chat && currentRoom) {
      await chat.sendMessage(currentRoom, message);
    }
  };

  return (
    <div>
      <h2>Rooms</h2>
      {rooms.map(room => (
        <div key={room.id} onClick={() => handleJoinRoom(room.id)}>
          {room.name} ({room.memberCount} members)
        </div>
      ))}
      
      {currentRoom && (
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
      )}
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

---

## Real-time Events

Messages are broadcast to all members of a room in real-time via WebSocket. When a user joins, leaves, or sends a message, all other members receive the event automatically.

**Note:** For receiving real-time events on the client, ensure your Sockress client is connected via WebSocket. The chat client will automatically handle message routing.

---

## License

PROPRIETARY - See [LICENSE](./LICENSE) for details.

---

## Support

For issues and questions, please visit: https://github.com/alsocoders/sockress/issues

