import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ChatService } from "./chat.service";
import type { TenantTokenClaims } from "@jenga/shared";
import type { Message, Conversation } from "./chat.service";

interface AuthRequest {
  user: TenantTokenClaims;
}

@Controller("chat")
@UseGuards(AuthGuard("jwt"))
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get("conversations")
  async listConversations(
    @Req() req: AuthRequest,
    @Query("limit") limit?: string,
  ): Promise<Conversation[]> {
    return this.chatService.listConversations(
      req.user,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Post("conversations/direct")
  async startDirectConversation(
    @Req() req: AuthRequest,
    @Body("otherUserId") otherUserId: string,
  ): Promise<{ conversationId: string }> {
    const conversationId = await this.chatService.getOrCreateDirectConversation(
      req.user,
      otherUserId,
    );
    return { conversationId };
  }

  @Post("conversations/department")
  async getDepartmentConversation(
    @Req() req: AuthRequest,
    @Body("departmentId") departmentId: string,
  ): Promise<{ conversationId: string }> {
    const conversationId = await this.chatService.getDepartmentConversation(
      req.user,
      departmentId,
    );
    return { conversationId };
  }

  @Get("conversations/org-broadcast")
  async getOrgBroadcast(@Req() req: AuthRequest): Promise<{ conversationId: string }> {
    const conversationId = await this.chatService.getOrgBroadcastConversation(req.user);
    return { conversationId };
  }

  @Get("messages")
  async getMessages(
    @Req() req: AuthRequest,
    @Query("conversationId") conversationId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<Message[]> {
    return this.chatService.getMessages(
      req.user,
      conversationId,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Post("messages")
  async sendMessage(
    @Req() req: AuthRequest,
    @Body("conversationId") conversationId: string,
    @Body("content") content: string,
    @Body("replyToId") replyToId?: string,
  ): Promise<Message> {
    return this.chatService.sendMessage(req.user, conversationId, content, replyToId);
  }

  @Post("messages/:messageId/reactions")
  async addReaction(
    @Req() req: AuthRequest,
    @Param("messageId") messageId: string,
    @Body("emoji") emoji: string,
  ): Promise<void> {
    return this.chatService.addReaction(req.user, messageId, emoji);
  }

  @Delete("messages/:messageId/reactions/:emoji")
  async removeReaction(
    @Req() req: AuthRequest,
    @Param("messageId") messageId: string,
    @Param("emoji") emoji: string,
  ): Promise<void> {
    return this.chatService.removeReaction(req.user, messageId, emoji);
  }

  @Post("presence/update")
  async updatePresence(
    @Req() req: AuthRequest,
    @Body("isOnline") isOnline: boolean,
  ): Promise<void> {
    return this.chatService.updatePresence(req.user, isOnline);
  }

  @Get("presence/online")
  async getOnlineUsers(
    @Req() req: AuthRequest,
  ): Promise<Array<{ id: string; name: string; lastSeen: string }>> {
    return this.chatService.getOnlineUsers(req.user);
  }
}
