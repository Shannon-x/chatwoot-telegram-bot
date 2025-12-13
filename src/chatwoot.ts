import axios from 'axios';
import http from 'http';
import https from 'https';
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
