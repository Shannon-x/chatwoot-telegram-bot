import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    download: vi.fn(),
    sendDocument: vi.fn(),
    sendMessage: vi.fn(),
    saveMapping: vi.fn(),
}));

vi.mock('axios', () => ({ default: { create: () => ({ get: mocks.download }) } }));
vi.mock('../config', () => ({ config: { chatwootBaseUrl: 'https://example.invalid', chatwootAccessToken: '' } }));
vi.mock('../bot-instance', () => ({ bot: { telegram: { sendDocument: mocks.sendDocument, sendMessage: mocks.sendMessage } } }));
vi.mock('../database', () => ({ saveMapping: mocks.saveMapping }));
vi.mock('../logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { sendAttachmentToTelegram } from '../attachments';
import type { ChatwootAttachment } from '../types';

const blobUrl = 'https://example.invalid/rails/active_storage/blobs/redirect/signed-blob/report.pdf';

function send(att: ChatwootAttachment) {
    return sendAttachmentToTelegram({ chatId: 'test-chat', att, conversationId: 1, accountId: 1 });
}

describe('document attachment filenames', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.download.mockResolvedValue({ data: Buffer.from('test content'), headers: { 'content-type': 'application/pdf' } });
    });

    it('keeps the direct URL path without downloading when Telegram accepts it', async () => {
        mocks.sendDocument.mockResolvedValue({ message_id: 10 });

        await send({ id: 7, data_url: blobUrl });

        expect(mocks.sendDocument).toHaveBeenCalledWith('test-chat', blobUrl, {});
        expect(mocks.download).not.toHaveBeenCalled();
        expect(mocks.saveMapping).toHaveBeenCalledWith(10, 1, 1, undefined);
    });

    it('uses the original Active Storage filename if the direct URL is rejected', async () => {
        mocks.sendDocument.mockRejectedValueOnce(new Error('URL rejected')).mockResolvedValueOnce({ message_id: 11 });

        await send({ id: 7, data_url: blobUrl, extension: 'pdf' });

        expect(mocks.download).toHaveBeenCalledOnce();
        expect(mocks.sendDocument).toHaveBeenNthCalledWith(2, 'test-chat', {
            source: Buffer.from('test content'), filename: 'report.pdf',
        }, {});
    });

    it('prefers an explicitly supplied filename', async () => {
        mocks.sendDocument.mockRejectedValueOnce(new Error('URL rejected')).mockResolvedValueOnce({ message_id: 12 });

        await send({ id: 7, data_url: blobUrl, file_name: 'provided.pdf' });

        expect(mocks.sendDocument.mock.calls[1][1].filename).toBe('provided.pdf');
    });

    it.each([
        ['https://example.invalid/rails/active_storage/blobs/proxy/blob/photo%20one.pdf', 'pdf', 'photo one.pdf'],
        ['https://example.invalid/rails/active_storage/blobs/redirect/blob/report.pdf', null, 'report.pdf'],
        ['https://example.invalid/rails/active_storage/blobs/redirect/blob/r%C3%A9sum%C3%A9.pdf', null, 'résumé.pdf'],
        [`https://example.invalid/rails/active_storage/blobs/redirect/blob/${'a'.repeat(205)}.pdf`, null, `${'a'.repeat(196)}.pdf`],
        ['https://example.invalid/rails/active_storage/blobs/redirect/blob/folder%2Freport.pdf', 'pdf', 'report.pdf'],
        ['https://example.invalid/rails/active_storage/blobs/redirect/blob/%ZZ', 'pdf', 'attachment-7.pdf'],
        ['https://example.invalid/rails/active_storage/blobs/redirect/signed-blob', 'pdf', 'attachment-7.pdf'],
        ['https://example.invalid/download/file', '../pdf', 'attachment-7'],
    ])('safely derives an upload filename for %s', async (data_url, extension, expected) => {
        mocks.sendDocument.mockRejectedValueOnce(new Error('URL rejected')).mockResolvedValueOnce({ message_id: 13 });

        await send({ id: 7, data_url, extension });

        expect(mocks.sendDocument.mock.calls[1][1].filename).toBe(expected);
    });

    it('keeps a neutral name for a data URL', async () => {
        mocks.sendDocument.mockResolvedValue({ message_id: 14 });

        await send({ id: 7, data_url: 'data:application/pdf;base64,dGVzdA==' });

        expect(mocks.sendDocument).toHaveBeenCalledWith('test-chat', {
            source: Buffer.from('test'), filename: 'attachment-7',
        }, {});
        expect(mocks.download).not.toHaveBeenCalled();
    });
});
