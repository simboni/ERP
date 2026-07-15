import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtAuthGuard, UserId } from "./guards";
import { AuthRateLimitGuard } from "./rate-limit.guard";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("signup")
  async signup(
    @Body()
    body: {
      email?: string;
      password?: string;
      fullName?: string;
      tenantName?: string;
      tenantSlug?: string;
    },
  ) {
    const { email, password, fullName, tenantName, tenantSlug } = body ?? {};
    if (!email || !EMAIL_RE.test(email)) {
      throw new BadRequestException("Valid email is required");
    }
    if (!password || password.length < 10) {
      throw new BadRequestException("Password must be at least 10 characters");
    }
    if (!fullName?.trim()) {
      throw new BadRequestException("Full name is required");
    }
    if (!tenantName?.trim()) {
      throw new BadRequestException("Workspace name is required");
    }
    if (!tenantSlug || !SLUG_RE.test(tenantSlug)) {
      throw new BadRequestException(
        "Workspace slug must be 3-40 chars of lowercase letters, digits or hyphens",
      );
    }
    const result = await this.auth.signup({
      email,
      password,
      fullName,
      tenantName,
      tenantSlug,
    });
    return result;
  }

  @Post("login")
  @HttpCode(200)
  @UseGuards(AuthRateLimitGuard)
  async login(@Body() body: { email?: string; password?: string }) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException("Email and password are required");
    }
    return this.auth.login(body.email, body.password);
  }

  @Post("totp/setup")
  @UseGuards(JwtAuthGuard)
  async totpSetup(@UserId() userId: string) {
    return this.auth.totpSetup(userId);
  }

  @Post("totp/enable")
  @UseGuards(JwtAuthGuard)
  async totpEnable(@UserId() userId: string, @Body() body: { code?: string }) {
    if (!body?.code) throw new BadRequestException("code is required");
    return this.auth.totpEnable(userId, body.code);
  }

  @Post("totp/verify")
  @HttpCode(200)
  @UseGuards(AuthRateLimitGuard)
  async totpVerify(@Body() body: { mfaToken?: string; code?: string }) {
    if (!body?.mfaToken || !body?.code) {
      throw new BadRequestException("mfaToken and code are required");
    }
    return this.auth.verifyTotpLogin(body.mfaToken, body.code);
  }

  /** Authenticated password change: verify the current, set the new. */
  @Post("change-password")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @UserId() userId: string,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    if (!body?.currentPassword || !body?.newPassword) {
      throw new BadRequestException(
        "currentPassword and newPassword are required",
      );
    }
    if (body.newPassword.length < 10) {
      throw new BadRequestException(
        "newPassword must be at least 10 characters",
      );
    }
    return this.auth.changePassword(
      userId,
      body.currentPassword,
      body.newPassword,
    );
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken?: string }) {
    if (!body?.refreshToken) {
      throw new BadRequestException("refreshToken is required");
    }
    return this.auth.refresh(body.refreshToken);
  }

  @Post("tenant-token")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async tenantToken(
    @UserId() userId: string,
    @Body() body: { tenantId?: string },
  ) {
    if (!body?.tenantId) {
      throw new BadRequestException("tenantId is required");
    }
    const accessToken = await this.auth.issueTenantToken(userId, body.tenantId);
    return { accessToken };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@UserId() userId: string) {
    const memberships = await this.auth.listMemberships(userId);
    return { userId, memberships };
  }
}
