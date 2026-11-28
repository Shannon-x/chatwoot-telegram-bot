import { TelegramError } from 'telegraf';

// Telegraf also synthesizes TelegramError on HTTP 5xx; only a parsed Bot API
// ok:false response with a 4xx code proves that Telegram rejected the request.
export function isTelegramRejection(error: unknown): boolean {
    if (!(error instanceof TelegramError)) return false;
    const response = error.response as unknown as {ok?: boolean; error_code?: number};
    return response.ok === false && Number.isInteger(response.error_code) &&
        response.error_code! >= 400 && response.error_code! < 500;
}

export function isRejectedFileUrl(error: unknown): boolean {
    return isTelegramRejection(error) && (error as TelegramError).response.error_code === 400 &&
        /(?:wrong file identifier|failed to get http url content|wrong http url|url host is empty|http url specified)/i.test((error as TelegramError).response.description || '');
}
