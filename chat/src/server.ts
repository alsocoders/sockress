import type { SockressApp, SockressRequest, SockressResponse, NextFunction } from 'sockress';
import { nanoid } from 'nanoid';
import type { Room, ChatMessage, RoomInfo, CreateRoomRequest, JoinRoomRequest, SendMessageRequest, ChatEvent } from './types';

export interface ChatServerOptions {
  pathPrefix?: string;
  getUserInfo?: (req: SockressRequest) => { userId: string; username?: string } | null;
  onMessage?: (message: ChatMessage) => void;
  onRoomCreated?: (room: Room) => void;
  onRoomDeleted?: (roomId: string) => void;
  onUserJoin?: (roomId: string, userId: string) => void;
  onUserLeave?: (roomId: string, userId: string) => void;
}

export class ChatServer {
  private rooms: Map<string, Room> = new Map();
  private userRooms: Map<string, Set<string>> = new Map();
  private options: Required<Pick<ChatServerOptions, 'pathPrefix'>> & ChatServerOptions;

  constructor(options: ChatServerOptions = {}) {
    this.options = {
      pathPrefix: options.pathPrefix || '/api/chat',
      ...options
    };
  }

  private getUserInfo(req: SockressRequest): { userId: string; username?: string } {
    if (this.options.getUserInfo) {
      const info = this.options.getUserInfo(req);
      if (info) return info;
    }
    return {
      userId: req.context?.userId as string || req.ip || nanoid(),
      username: req.context?.username as string || undefined
    };
  }

  private connectionMap: Map<string, Set<{ socket: any; userId: string }>> = new Map();

  private broadcastToRoom(roomId: string, event: ChatEvent, excludeUserId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const connections = this.connectionMap.get(roomId);
    if (!connections) return;

    const eventData = JSON.stringify(event);
    for (const conn of connections) {
      if (conn.userId === excludeUserId) continue;
      if (conn.socket && conn.socket.readyState === 1) {
        try {
          conn.socket.send(eventData);
        } catch (error) {
          connections.delete(conn);
        }
      } else {
        connections.delete(conn);
      }
    }
  }

  private registerConnection(roomId: string, userId: string, socket: any): void {
    if (!this.connectionMap.has(roomId)) {
      this.connectionMap.set(roomId, new Set());
    }
    const connections = this.connectionMap.get(roomId)!;
    
    for (const conn of connections) {
      if (conn.userId === userId) {
        if (conn.socket !== socket) {
          conn.socket = socket;
        }
        return;
      }
    }
    connections.add({ socket, userId });
  }

  private unregisterConnection(roomId: string, userId: string): void {
    const connections = this.connectionMap.get(roomId);
    if (connections) {
      for (const conn of connections) {
        if (conn.userId === userId) {
          connections.delete(conn);
        }
      }
      if (connections.size === 0) {
        this.connectionMap.delete(roomId);
      }
    }
  }

  private getRoomInfo(room: Room): RoomInfo {
    return {
      id: room.id,
      name: room.name,
      memberCount: room.members.size,
      maxMembers: room.maxMembers,
      isPrivate: room.isPrivate,
      createdAt: room.createdAt
    };
  }

  setupRoutes(app: SockressApp): void {
    const prefix = this.options.pathPrefix;

    app.post(`${prefix}/rooms`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const body = req.body as CreateRoomRequest;
        if (!body.name || typeof body.name !== 'string') {
          return res.status(400).json({ error: 'Room name is required' });
        }

        const userInfo = this.getUserInfo(req);
        const roomId = nanoid();
        const room: Room = {
          id: roomId,
          name: body.name,
          createdAt: Date.now(),
          createdBy: userInfo.userId,
          members: new Set([userInfo.userId]),
          maxMembers: body.maxMembers,
          isPrivate: body.isPrivate || false
        };

        this.rooms.set(roomId, room);
        if (!this.userRooms.has(userInfo.userId)) {
          this.userRooms.set(userInfo.userId, new Set());
        }
        this.userRooms.get(userInfo.userId)!.add(roomId);

        const roomInfo = this.getRoomInfo(room);
        if (this.options.onRoomCreated) {
          this.options.onRoomCreated(room);
        }

        res.json({ room: roomInfo });
      } catch (error) {
        res.status(500).json({ error: 'Failed to create room' });
      }
    });

    app.post(`${prefix}/rooms/:roomId/join`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const roomId = req.params.roomId as string;
        const room = this.rooms.get(roomId);

        if (!room) {
          return res.status(404).json({ error: 'Room not found' });
        }

        if (room.isPrivate) {
          return res.status(403).json({ error: 'Room is private' });
        }

        if (room.maxMembers && room.members.size >= room.maxMembers) {
          return res.status(400).json({ error: 'Room is full' });
        }

        const userInfo = this.getUserInfo(req);
        if (room.members.has(userInfo.userId)) {
          return res.json({ room: this.getRoomInfo(room), message: 'Already in room' });
        }

        room.members.add(userInfo.userId);
        if (!this.userRooms.has(userInfo.userId)) {
          this.userRooms.set(userInfo.userId, new Set());
        }
        this.userRooms.get(userInfo.userId)!.add(roomId);

        const socket = (res as any).mode?.socket;
        if (socket) {
          this.registerConnection(roomId, userInfo.userId, socket);
        }

        const joinMessage: ChatMessage = {
          id: nanoid(),
          roomId,
          userId: userInfo.userId,
          username: userInfo.username,
          message: `${userInfo.username || userInfo.userId} joined the room`,
          timestamp: Date.now(),
          type: 'join'
        };

        this.broadcastToRoom(roomId, { type: 'join', data: joinMessage }, userInfo.userId);

        if (this.options.onUserJoin) {
          this.options.onUserJoin(roomId, userInfo.userId);
        }

        res.json({ room: this.getRoomInfo(room), message: 'Joined room successfully' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to join room' });
      }
    });

    app.post(`${prefix}/rooms/:roomId/leave`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const roomId = req.params.roomId as string;
        const room = this.rooms.get(roomId);

        if (!room) {
          return res.status(404).json({ error: 'Room not found' });
        }

        const userInfo = this.getUserInfo(req);
        if (!room.members.has(userInfo.userId)) {
          return res.status(400).json({ error: 'Not a member of this room' });
        }

        room.members.delete(userInfo.userId);
        const userRooms = this.userRooms.get(userInfo.userId);
        if (userRooms) {
          userRooms.delete(roomId);
          if (userRooms.size === 0) {
            this.userRooms.delete(userInfo.userId);
          }
        }

        this.unregisterConnection(roomId, userInfo.userId);

        const leaveMessage: ChatMessage = {
          id: nanoid(),
          roomId,
          userId: userInfo.userId,
          username: userInfo.username,
          message: `${userInfo.username || userInfo.userId} left the room`,
          timestamp: Date.now(),
          type: 'leave'
        };

        this.broadcastToRoom(roomId, { type: 'leave', data: leaveMessage }, userInfo.userId);

        if (room.members.size === 0) {
          this.rooms.delete(roomId);
          if (this.options.onRoomDeleted) {
            this.options.onRoomDeleted(roomId);
          }
        } else if (this.options.onUserLeave) {
          this.options.onUserLeave(roomId, userInfo.userId);
        }

        res.json({ message: 'Left room successfully' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to leave room' });
      }
    });

    app.post(`${prefix}/rooms/:roomId/messages`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const roomId = req.params.roomId as string;
        const body = req.body as SendMessageRequest;

        if (!body.message || typeof body.message !== 'string') {
          return res.status(400).json({ error: 'Message is required' });
        }

        const room = this.rooms.get(roomId);
        if (!room) {
          return res.status(404).json({ error: 'Room not found' });
        }

        const userInfo = this.getUserInfo(req);
        if (!room.members.has(userInfo.userId)) {
          return res.status(403).json({ error: 'Not a member of this room' });
        }

        const socket = (res as any).mode?.socket;
        if (socket) {
          this.registerConnection(roomId, userInfo.userId, socket);
        }

        const chatMessage: ChatMessage = {
          id: nanoid(),
          roomId,
          userId: userInfo.userId,
          username: userInfo.username || body.username,
          message: body.message,
          timestamp: Date.now(),
          type: 'message'
        };

        const event: ChatEvent = { type: 'message', data: chatMessage };
        this.broadcastToRoom(roomId, event);

        if (this.options.onMessage) {
          this.options.onMessage(chatMessage);
        }

        res.json({ message: chatMessage });
      } catch (error) {
        res.status(500).json({ error: 'Failed to send message' });
      }
    });

    app.get(`${prefix}/rooms`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const rooms: RoomInfo[] = Array.from(this.rooms.values())
          .filter(room => !room.isPrivate)
          .map(room => this.getRoomInfo(room));

        res.json({ rooms });
      } catch (error) {
        res.status(500).json({ error: 'Failed to list rooms' });
      }
    });

    app.get(`${prefix}/rooms/:roomId`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const roomId = req.params.roomId as string;
        const room = this.rooms.get(roomId);

        if (!room) {
          return res.status(404).json({ error: 'Room not found' });
        }

        const userInfo = this.getUserInfo(req);
        if (room.isPrivate && !room.members.has(userInfo.userId)) {
          return res.status(403).json({ error: 'Access denied' });
        }

        res.json({ room: this.getRoomInfo(room) });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get room' });
      }
    });

    app.delete(`${prefix}/rooms/:roomId`, (req: SockressRequest, res: SockressResponse) => {
      try {
        const roomId = req.params.roomId as string;
        const room = this.rooms.get(roomId);

        if (!room) {
          return res.status(404).json({ error: 'Room not found' });
        }

        const userInfo = this.getUserInfo(req);
        if (room.createdBy !== userInfo.userId) {
          return res.status(403).json({ error: 'Only room creator can delete the room' });
        }

        for (const userId of room.members) {
          const userRooms = this.userRooms.get(userId);
          if (userRooms) {
            userRooms.delete(roomId);
            if (userRooms.size === 0) {
              this.userRooms.delete(userId);
            }
          }
        }

        this.rooms.delete(roomId);

        if (this.options.onRoomDeleted) {
          this.options.onRoomDeleted(roomId);
        }

        res.json({ message: 'Room deleted successfully' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to delete room' });
      }
    });
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getUserRooms(userId: string): string[] {
    const rooms = this.userRooms.get(userId);
    return rooms ? Array.from(rooms) : [];
  }

  getAllRooms(): RoomInfo[] {
    return Array.from(this.rooms.values()).map(room => this.getRoomInfo(room));
  }
}

export function sockressChatServer(options?: ChatServerOptions): ChatServer {
  return new ChatServer(options);
}

export const createChatServer = sockressChatServer;

