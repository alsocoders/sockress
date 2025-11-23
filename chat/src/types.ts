export interface Room {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  members: Set<string>;
  maxMembers?: number;
  isPrivate: boolean;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  username?: string;
  message: string;
  timestamp: number;
  type?: 'message' | 'system' | 'join' | 'leave';
}

export interface RoomInfo {
  id: string;
  name: string;
  memberCount: number;
  maxMembers?: number;
  isPrivate: boolean;
  createdAt: number;
}

export interface CreateRoomRequest {
  name: string;
  maxMembers?: number;
  isPrivate?: boolean;
}

export interface JoinRoomRequest {
  roomId: string;
}

export interface SendMessageRequest {
  roomId: string;
  message: string;
  username?: string;
}

export interface ChatEvent {
  type: 'message' | 'join' | 'leave' | 'room_created' | 'room_deleted' | 'error';
  data: ChatMessage | RoomInfo | { message: string; code?: string };
}

