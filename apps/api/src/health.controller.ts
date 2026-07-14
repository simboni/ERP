import { Controller, Get } from "@nestjs/common";
import { DbService } from "./db/db.service";

@Controller("health")
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async health() {
    await this.db.query("SELECT 1");
    return { status: "ok" };
  }
}
