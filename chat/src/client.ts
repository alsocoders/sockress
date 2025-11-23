import type { SockressClient } from 'sockress-client';
import type { RoomInfo, ChatMessage, CreateRoomRequest, SendMessageRequest, ChatEvent } from './types';

export interface ChatClientOptions {
  client: SockressClient;
  pathPrefix?: string;
  userId?: string;
  username?: string;
  onMessage?: (message: ChatMessage) => void;
  onJoin?: (roomId: string, userId: string) => void;
  onLeave?: (roomId: string, userId: string) => void;
  onRoomCreated?: (room: RoomInfo) => void;
  onRoomDeleted?: (roomId: string) => void;
  onError?: (error: { message: string; code?: string }) => void;
}

export class ChatClient {
  private client: SockressClient;
  private prefix: string;
  private userId?: string;
  private username?: string;
  private options: ChatClientOptions;
  private messageListeners: Map<string, Set<(message: ChatMessage) => void>> = new Map();
  private eventListeners: Set<(event: ChatEvent) => void> = new Set();

  constructor(options: ChatClientOptions) {
    this.client = options.client;
    this.prefix = options.pathPrefix || '/api/chat';
    this.userId = options.userId;
    this.username = options.username;
    this.options = options;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    const messageHandler = (payload: any) => {
      if (payload && payload.type && !payload.id) {
        this.handleEvent(payload);
      }
    };
    
    if ((this.client as any).on) {
      (this.client as any).on('message', messageHandler);
      (this.client as any).on('open', () => {
        (this.client as any).off('message', messageHandler);
        (this.client as any).on('message', messageHandler);
      });
    }
  }

  private handleEvent(event: ChatEvent): void {
    if (event.type === 'message' && 'id' in event.data) {
      const message = event.data as ChatMessage;
      const listeners = this.messageListeners.get(message.roomId);
      if (listeners) {
        listeners.forEach(listener => listener(message));
      }
      if (this.options.onMessage) {
        this.options.onMessage(message);
      }
    } else if (event.type === 'join' && 'roomId' in event.data) {
      const message = event.data as ChatMessage;
      if (this.options.onJoin) {
        this.options.onJoin(message.roomId, message.userId);
      }
    } else if (event.type === 'leave' && 'roomId' in event.data) {
      const message = event.data as ChatMessage;
      if (this.options.onLeave) {
        this.options.onLeave(message.roomId, message.userId);
      }
    } else if (event.type === 'room_created' && 'id' in event.data) {
      const room = event.data as RoomInfo;
      if (this.options.onRoomCreated) {
        this.options.onRoomCreated(room);
      }
    } else if (event.type === 'room_deleted') {
      if (this.options.onRoomDeleted) {
        this.options.onRoomDeleted((event.data as any).roomId || '');
      }
    } else if (event.type === 'error') {
      if (this.options.onError) {
        this.options.onError(event.data as { message: string; code?: string });
      }
    }
  }

  async createRoom(data: CreateRoomRequest): Promise<RoomInfo> {
    const response = await this.client.post(`${this.prefix}/rooms`, {
      body: data
    });
    const result = await response.json<{ room: RoomInfo }>();
    return result.room;
  }

  async joinRoom(roomId: string): Promise<RoomInfo> {
    const response = await this.client.post(`${this.prefix}/rooms/${roomId}/join`, {});
    const result = await response.json<{ room: RoomInfo; message?: string }>();
    return result.room;
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.client.post(`${this.prefix}/rooms/${roomId}/leave`, {});
  }

  async sendMessage(roomId: string, message: string): Promise<ChatMessage> {
    const response = await this.client.post(`${this.prefix}/rooms/${roomId}/messages`, {
      body: {
        roomId,
        message,
        username: this.username
      } as SendMessageRequest
    });
    const result = await response.json<{ message: ChatMessage }>();
    return result.message;
  }

  async listRooms(): Promise<RoomInfo[]> {
    const response = await this.client.get(`${this.prefix}/rooms`);
    const result = await response.json<{ rooms: RoomInfo[] }>();
    return result.rooms;
  }

  async getRoom(roomId: string): Promise<RoomInfo> {
    const response = await this.client.get(`${this.prefix}/rooms/${roomId}`);
    const result = await response.json<{ room: RoomInfo }>();
    return result.room;
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.client.delete(`${this.prefix}/rooms/${roomId}`);
  }

  onRoomMessage(roomId: string, callback: (message: ChatMessage) => void): () => void {
    if (!this.messageListeners.has(roomId)) {
      this.messageListeners.set(roomId, new Set());
    }
    this.messageListeners.get(roomId)!.add(callback);

    return () => {
      const listeners = this.messageListeners.get(roomId);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.messageListeners.delete(roomId);
        }
      }
    };
  }

  onEvent(callback: (event: ChatEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => {
      this.eventListeners.delete(callback);
    };
  }
}

export function sockressChatClient(options: ChatClientOptions): ChatClient {
  return new ChatClient(options);
}

export const createChatClient = sockressChatClient;

