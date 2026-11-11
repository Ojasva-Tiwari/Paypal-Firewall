/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-A: Telegram Bot Types & Contracts
 *
 * Implements:
 * - Typed Telegram Bot API payload interfaces (Update, Message, CallbackQuery, InlineKeyboard)
 * - Telegram HTTP client options, response, and error interfaces
 * - Redaction contracts for sensitive tokens
 */

export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
  readonly title?: string;
  readonly username?: string;
  readonly first_name?: string;
  readonly last_name?: string;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly url?: string;
  readonly callback_data?: string;
}

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly inline_message_id?: string;
  readonly data?: string;
  readonly chat_instance: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

export interface TelegramWebhookInfo {
  readonly url: string;
  readonly has_custom_certificate: boolean;
  readonly pending_update_count: number;
  readonly ip_address?: string;
  readonly last_error_date?: number;
  readonly last_error_message?: string;
  readonly max_connections?: number;
  readonly allowed_updates?: readonly string[];
}

export interface TelegramApiResponse<T = unknown> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
  readonly parameters?: {
    readonly retry_after?: number;
    readonly migrate_to_chat_id?: number;
  };
}

export interface SendMessageParams {
  readonly chat_id: number | string;
  readonly text: string;
  readonly parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  readonly reply_markup?: TelegramInlineKeyboardMarkup;
  readonly disable_web_page_preview?: boolean;
}

export interface EditMessageTextParams {
  readonly chat_id?: number | string;
  readonly message_id?: number;
  readonly inline_message_id?: string;
  readonly text: string;
  readonly parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  readonly reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface EditMessageReplyMarkupParams {
  readonly chat_id?: number | string;
  readonly message_id?: number;
  readonly inline_message_id?: string;
  readonly reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface AnswerCallbackQueryParams {
  readonly callback_query_id: string;
  readonly text?: string;
  readonly show_alert?: boolean;
  readonly url?: string;
  readonly cache_time?: number;
}

export interface SetWebhookParams {
  readonly url: string;
  readonly secret_token?: string;
  readonly max_connections?: number;
  readonly allowed_updates?: readonly string[];
  readonly drop_pending_updates?: boolean;
}

export interface DeleteWebhookParams {
  readonly drop_pending_updates?: boolean;
}

export interface TelegramClientLogger {
  readonly info?: (msg: string, ...args: unknown[]) => void;
  readonly warn?: (msg: string, ...args: unknown[]) => void;
  readonly error?: (msg: string, ...args: unknown[]) => void;
}

export type FetchFunction = typeof globalThis.fetch;

export interface TelegramRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface TelegramClientOptions {
  readonly botToken: string;
  readonly apiBaseUrl?: string; // Default: 'https://api.telegram.org'
  readonly timeoutMs?: number;  // Default: 5000ms
  readonly maxRetries?: number; // Default: 1
  readonly logger?: TelegramClientLogger;
  readonly fetchFn?: FetchFunction;
}

