import { Module } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";
import { DbService } from "../db/db.service";

@Module({
  providers: [DbService, ChatService],
  controllers: [ChatController],
  exports: [ChatService],
})
export class ChatModule {}
