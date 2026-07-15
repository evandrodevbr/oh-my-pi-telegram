/**
 * Public Telegram updates API
 * Zones: package boundary, extension interop
 * Exposes the stable raw-update handler surface while keeping update routing internals package-private
 */

export {
  registerTelegramUpdateHandler,
  type TelegramUpdateHandler,
  type TelegramUpdateHandlerVerdict,
} from "../lib/updates.ts";
