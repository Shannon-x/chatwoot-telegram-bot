import axios from 'axios';
import http from 'http';
import https from 'https';
import FormData from 'form-data';
import { config } from './config';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Create axios client with api_access_token in headers
const client = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 15_000,
    httpAgent,
    httpsAgent,
    headers: {
        'api_access_token': config.chatwootAccessToken,
        'Content-Type': 'application/json',
    },
});

// Axios client for file uploads (without Content-Type header, will be set by FormData)
const uploadClient = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 60_000, // 附件上传可能需要更长时间
    httpAgent,
    httpsAgent,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
});

export async function createMessage(conversationId: number, content: string) {
    try {
        const accountId = config.chatwootAccountId;
        // URL: /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;

        const response = await client.post(url, {
            content: content,
            message_type: 'outgoing', // Since we are posting on behalf of agent/system
            private: false,
        });

        return response.data;
    } catch (error) {
        console.error('Error creating Chatwoot message:', error);
        throw error;
    }
}

/**
 * 创建带附件的消息
 * Chatwoot API 使用 multipart/form-data 上传附件
 */
export async function createMessageWithAttachment(
    conversationId: number,
    content: string,
    attachment: {
        buffer: Buffer;
        filename: string;
        mimeType?: string;
    }
) {
    try {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;

        const formData = new FormData();
        formData.append('content', content || '');
        formData.append('message_type', 'outgoing');
        formData.append('private', 'false');
        formData.append('attachments[]', attachment.buffer, {
            filename: attachment.filename,
            contentType: attachment.mimeType || 'application/octet-stream',
        });

        const response = await uploadClient.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
                'api_access_token': config.chatwootAccessToken,
            },
        });

        return response.data;
    } catch (error: any) {
        console.error('Error creating Chatwoot message with attachment:', error?.response?.data || error);
        throw error;
    }
}

export async function toggleConversationStatus(conversationId: number, status: 'open' | 'resolved') {
    try {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;

        const response = await client.post(url, { status });
        return response.data;
    } catch (error) {
        console.error('Error toggling conversation status:', error);
        throw error;
    }
}
