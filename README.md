# Chatwoot Telegram Bot Bridge

这是一个连接 Chatwoot 和 Telegram 的中间件机器人。它允许您通过 Telegram 机器人直接接收和回复 Chatwoot 中的客户消息。

## 功能

*   **双向同步**：
    *   **接收**：Chatwoot 收到客户消息 -> 转发给您的 Telegram 机器人。
    *   **回复**：在 Telegram 回复消息 -> 自动同步回 Chatwoot 发送给客户。
*   **多用户支持**：通过消息引用机制，完美支持多用户并发对话。
*   **状态管理**：可以在 Telegram 中直接点击按钮将对话标记为“已解决”。
*   **即时通知**：支持转发 AI/Agent 的回复消息。

## 快速开始 (Docker)

1.  **克隆仓库**
    ```bash
    git clone https://github.com/Shannon-x/chatwoot-telegram-bot.git
    cd chatwoot-telegram-bot
    ```

2.  **配置环境变量**
    复制示例配置：
    ```bash
    cp .env.example .env
    ```
    编辑 `.env` 文件，填入您的 Chatwoot 和 Telegram配置信息。

3.  **启动服务**
    ```bash
    docker-compose up -d
    ```

4.  **配置 Chatwoot Webhook**
    在 Chatwoot 后台 (设置 -> 集成 -> Webhooks) 添加您的服务器地址：
    `http://<您的IP>:3000/webhook`

## 环境变量说明

| 变量名 | 说明 |
| :--- | :--- |
| `PORT` | 服务端口 (默认 3000) |
| `TELEGRAM_TOKEN` | Telegram Bot Token (来自 @BotFather) |
| `TELEGRAM_ADMIN_ID` | 您的 Telegram User ID (用于接收消息) |
| `CHATWOOT_ACCESS_TOKEN` | Chatwoot API Access Token |
| `CHATWOOT_BASE_URL` | Chatwoot 实例地址 (如 https://app.chatwoot.com) |
| `CHATWOOT_ACCOUNT_ID` | Account ID (通常为 1) |

## 许可证

MIT License © 2025 [Shannon-x](./LICENSE)
