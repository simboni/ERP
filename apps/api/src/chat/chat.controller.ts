import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  JwtAuthGuard,
  TenantContextGuard,
  TenantClaims,
} from "../auth/guards";
import { ChatService } from "./chat.service";
import type { TenantTokenClaims } from "@jenga/shared";
import type { Message, Conversation } from "./chat.service";

@Controller("chat")
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get("conversations")
  async listConversations(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("limit") limit?: string,
  ): Promise<Conversation[]> {
    return this.chatService.listConversations(
      claims,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Post("conversations/direct")
  async startDirectConversation(
    @TenantClaims() claims: TenantTokenClaims,
    @Body("otherUserId") otherUserId: string,
  ): Promise<{ conversationId: string }> {
    const conversationId = await this.chatService.getOrCreateDirectConversation(
      claims,
      otherUserId,
    );
    return { conversationId };
  }

  @Post("conversations/department")
  async getDepartmentConversation(
    @TenantClaims() claims: TenantTokenClaims,
    @Body("departmentId") departmentId: string,
  ): Promise<{ conversationId: string }> {
    const conversationId = await this.chatService.getDepartmentConversation(
      claims,
      departmentId,
    );
    return { conversationId };
  }

  @Get("conversations/org-broadcast")
  async getOrgBroadcast(@TenantClaims() claims: TenantTokenClaims): Promise<{ conversationId: string }> {
    const conversationId = await this.chatService.getOrgBroadcastConversation(claims);
    return { conversationId };
  }

  @Get("messages")
  async getMessages(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("conversationId") conversationId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<Message[]> {
    return this.chatService.getMessages(
      claims,
      conversationId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Post("messages")
  async sendMessage(
    @TenantClaims() claims: TenantTokenClaims,
    @Body("conversationId") conversationId: string,
    @Body("content") content: string,
    @Body("replyToId") replyToId?: string,
  ): Promise<Message> {
    return this.chatService.sendMessage(claims, conversationId, content, replyToId);
  }

  @Post("messages/:messageId/reactions")
  async addReaction(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("messageId") messageId: string,
    @Body("emoji") emoji: string,
  ): Promise<void> {
    return this.chatService.addReaction(claims, messageId, emoji);
  }

  @Delete("messages/:messageId/reactions/:emoji")
  async removeReaction(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("messageId") messageId: string,
    @Param("emoji") emoji: string,
  ): Promise<void> {
    return this.chatService.removeReaction(claims, messageId, emoji);
  }

  @Post("presence/update")
  async updatePresence(
    @TenantClaims() claims: TenantTokenClaims,
    @Body("isOnline") isOnline: boolean,
  ): Promise<void> {
    return this.chatService.updatePresence(claims, isOnline);
  }

  @Get("presence/online")
  async getOnlineUsers(
    @TenantClaims() claims: TenantTokenClaims,
  ): Promise<Array<{ id: string; name: string; lastSeen: string }>> {
    return this.chatService.getOnlineUsers(claims);
  }
}
