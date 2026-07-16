import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { DemoService } from "./demo.service";

/**
 * PUBLIC demo/trial signup. No auth guard: a visitor with no account spins up
 * a throwaway workspace and is handed a live session. Rate limiting rides the
 * existing global throttler — no new infrastructure here.
 */
@Controller("auth")
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Post("demo")
  @HttpCode(201)
  async createDemo(@Body() body: { businessType?: string }) {
    return this.demo.createDemo(body?.businessType);
  }
}
