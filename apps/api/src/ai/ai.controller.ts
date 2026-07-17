import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import type { TenantTokenClaims } from "@jenga/shared";
import { AiService, type AiTurn, type AskResult } from "./ai.service";

@Controller("ai")
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Whether the assistant is configured (drives UI empty-state). */
  @Get("status")
  status(): { enabled: boolean } {
    return { enabled: this.ai.enabled };
  }

  /**
   * One assistant turn. The client sends the visible conversation (user +
   * assistant text turns); tool calls happen server-side within this request.
   */
  @Post("ask")
  @HttpCode(200)
  async ask(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { messages?: AiTurn[] },
  ): Promise<AskResult> {
    return this.ai.ask(claims, body?.messages ?? []);
  }
}
