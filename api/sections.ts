/**
 * Public Telegram sections API
 * Zones: package boundary, extension interop
 * Exposes the stable managed Telegram menu-section surface while keeping registry internals package-private
 */

export {
  getTelegramSectionDiagnostics,
  registerTelegramSection,
  type TelegramSectionCallbackContext,
  type TelegramSectionCallbackResult,
  type TelegramSectionContext,
  type TelegramSectionDiagnostic,
  type TelegramSectionRegistration,
  type TelegramSectionSettingsRegistration,
  type TelegramSectionView,
} from "../lib/sections.ts";
