// ============ Chatwoot Webhook Event Types ============

/** 联系人 `additional_attributes` 中可能存在的浏览器/设备字段 */
export interface ChatwootBrowserInfo {
    browser_name?: string;
    browser_version?: string;
    device_name?: string;
    platform_name?: string;
    platform_version?: string;
}

/** 联系人 `additional_attributes` 通常存放渠道（Web Widget）采集到的元信息 */
export interface ChatwootAdditionalAttributes {
    /** ISO 国家代码，如 "CN" */
    country_code?: string;
    /** 国家全名 */
    country?: string;
    /** 城市 */
    city?: string;
    /** 浏览器语言 */
    browser_language?: string;
    /** Web Widget 来源页面 */
    referer?: string;
    /** 首次注册 IP */
    created_at_ip?: string;
    /** 客户端首次访问时间戳（秒/毫秒） */
    initiated_at?: { timestamp?: string | number };
    /** 浏览器/设备信息 */
    browser?: ChatwootBrowserInfo;
    [key: string]: unknown;
}

export interface ChatwootSender {
    id?: number;
    name?: string;
    email?: string;
    phone_number?: string;
    identifier?: string;
    thumbnail?: string;
    avatar_url?: string;
    type?: string; // 'contact' | 'user' | 'agent_bot'
    additional_attributes?: ChatwootAdditionalAttributes;
    custom_attributes?: Record<string, unknown>;
}

/** 渠道侧账户标识（如 Telegram chat id / Email / Instagram username） */
export interface ChatwootContactInbox {
    source_id?: string;
}

export interface ChatwootInbox {
    id?: number;
    name?: string;
    channel_type?: string;
}

export interface ChatwootConversationMeta {
    sender?: ChatwootSender;
    assignee?: { id?: number; name?: string; email?: string } | null;
    team?: { id?: number; name?: string } | null;
}

export interface ChatwootConversation {
    id: number;
    account_id?: number;
    inbox_id?: number;
    status?: string;
    /** 对话级 additional_attributes（Web Widget 会附带浏览器信息） */
    additional_attributes?: ChatwootAdditionalAttributes;
    custom_attributes?: Record<string, unknown>;
    /** 渠道类型快捷字段 */
    channel?: string;
    contact_inbox?: ChatwootContactInbox;
    labels?: string[];
    /** 联系人元信息：outgoing 消息中通过此字段获取真实联系人 */
    meta?: ChatwootConversationMeta;
}

export interface ChatwootAccount {
    id: number;
    name?: string;
}

export interface ChatwootAttachment {
    id?: number;
    file_type?: string;
    content_type?: string;
    file_name?: string;
    extension?: string | null;
    file_size?: number;
    size?: number;
    url?: string;
    file_url?: string;
    download_url?: string;
    data_url?: string;
    thumb_url?: string;
}

export interface ChatwootMessageEvent {
    event: 'message_created';
    id?: number;
    content?: string;
    message_type?: 'incoming' | 'outgoing' | 'activity' | 'template';
    private?: boolean;
    content_attributes?: Record<string, unknown>;
    sender?: ChatwootSender;
    conversation?: ChatwootConversation;
    account?: ChatwootAccount;
    inbox?: ChatwootInbox;
    attachments?: ChatwootAttachment[];
    message?: { attachments?: ChatwootAttachment[] };
    created_at?: string | number;
}

export interface ChatwootConversationStatusEvent {
    event: 'conversation_status_changed';
    id?: number;
    status?: 'open' | 'resolved' | 'pending' | 'snoozed';
    conversation?: ChatwootConversation;
}

export type ChatwootWebhookEvent = ChatwootMessageEvent | ChatwootConversationStatusEvent;

// ============ Chatwoot API Response Types ============

export interface CannedResponse {
    id: number;
    short_code: string;
    content: string;
}

/** Chatwoot 自定义属性定义类型 */
export type CustomAttributeType = 'text' | 'number' | 'currency' | 'percent' | 'link' | 'date' | 'list' | 'checkbox';

/** Chatwoot 自定义属性定义（GET /api/v1/accounts/:id/custom_attribute_definitions） */
export interface CustomAttributeDefinition {
    id: number;
    /** 中文显示名，如「账户余额」 */
    attribute_display_name: string;
    /** 字符串枚举类型 */
    attribute_display_type: CustomAttributeType | string;
    attribute_description?: string;
    /** 英文键名，如「xboard_balance」 */
    attribute_key: string;
    attribute_values?: string[];
    /** "conversation_attribute" | "contact_attribute" | "company_attribute" */
    attribute_model: string;
}

/** Chatwoot 联系人 API 响应（简化版） */
export interface ChatwootContactDetail {
    id: number;
    name?: string;
    email?: string;
    phone_number?: string;
    identifier?: string;
    thumbnail?: string;
    additional_attributes?: ChatwootAdditionalAttributes;
    custom_attributes?: Record<string, unknown>;
    contact_inboxes?: Array<{ source_id?: string; inbox?: ChatwootInbox }>;
}

// ============ Contact Card Input ============

/** 渲染欢迎卡片所需的完整联系人信息（从 webhook payload 中提取） */
export interface ContactCardInfo {
    /** 联系人 ID（用于按钮点击后调 API 拉详情） */
    contactId?: number;
    name: string;
    email?: string;
    phoneNumber?: string;
    identifier?: string;
    sourceId?: string;
    channel?: string;
    inboxName?: string;
    country?: string;
    city?: string;
    countryCode?: string;
    browserName?: string;
    browserVersion?: string;
    platformName?: string;
    /** 操作系统版本，如 Android 后面的 "16"、Windows 后面的 "10.0" */
    platformVersion?: string;
    deviceName?: string;
    browserLanguage?: string;
    referer?: string;
    createdAtIp?: string;
    /** 首次访问时间，秒级时间戳 */
    initiatedAt?: number;
    customAttributes?: Record<string, unknown>;
    labels?: string[];
}
