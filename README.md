# Chatwoot Telegram Bot Bridge

<div align="center">

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-shannon--x%2Fchatwoot--telegram--bot-blue?logo=github)](https://github.com/Shannon-x/chatwoot-telegram-bot/pkgs/container/chatwoot-telegram-bot)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/Shannon-x/chatwoot-telegram-bot/docker-build.yml?branch=main&label=Docker%20Build)](https://github.com/Shannon-x/chatwoot-telegram-bot/actions)
[![License](https://img.shields.io/github/license/Shannon-x/chatwoot-telegram-bot)](./LICENSE)

一个轻量级、功能强大的 Chatwoot 和 Telegram 双向消息桥接服务。

[功能特性](#-功能特性) • [详细部署教程](#-详细部署教程) • [配置说明](#-配置说明) • [使用指南](#-使用指南) • [常见问题](#-常见问题)

</div>

---

## 📖 简介

这是一个连接 **Chatwoot** 和 **Telegram** 的中间件机器人。通过 Telegram Bot 直接接收和回复 Chatwoot 中的客户消息，让客服团队可以在 Telegram 中高效处理客户咨询，无需时刻盯着 Chatwoot 后台网页。

For opt-in message recovery, required settings, backup precautions, attachment origin compatibility and manual resolution of uncertain deliveries, read [RECONCILIATION.md](./RECONCILIATION.md) before upgrading or enabling recovery.

## ✨ 最新功能特性

- 🔄 **双向消息同步**：Chatwoot 客户消息实时推送到 Telegram，Telegram 回复自动同步到 Chatwoot。
- 💬 **Forum Topics 会话隔离**：每个客户对话自动在 Telegram 群组中创建独立话题（Topic），彻底解决多用户同时对话时的消息混乱问题。对话结束自动关闭话题。
- 📎 **全媒体格式支持**：支持双向发送图片、文档、视频、音频、语音、视频笔记（圆形视频）、贴纸和 GIF 动画。
- 📋 **预设回复 (Canned Responses)**：在 Telegram 中输入 `/canned` 命令，直接调用 Chatwoot 后台配置的快捷回复，支持翻页和搜索。
- 🛡️ **安全与稳定性增强**：
  - **Webhook 签名验证**：确保消息来源绝对安全。
  - **消息去重机制**：防止网络波动导致的消息重复发送。
  - **API 指数退避重试**：可安全重试的请求采用退避；创建消息的未知结果需要人工确认。
  - **防消息死循环**：智能识别并过滤机器人自己发送的消息。
- 🎯 **便捷操作按钮**：一键标记会话为"已解决"、一键重新打开、快速跳转 Chatwoot 后台。
- ⌨️ **输入状态同步**：在 Telegram 中打字时，Chatwoot 网页端会实时显示“客服正在输入...”。

---

## 🚀 详细部署教程

部署本服务需要您具备一台可以访问外网的服务器（VPS），并已安装 Docker 和 Docker Compose。

### 第一步：准备工作（获取各项 Token 和 ID）

1. **获取 Telegram Bot Token**
   - 在 Telegram 中搜索并打开 [@BotFather](https://t.me/BotFather)。
   - 发送 `/newbot`，按提示设置机器人的名称（Name）和用户名（Username，必须以 bot 结尾）。
   - 创建成功后，BotFather 会发给你一串 Token（例如：`1234567890:ABCdefGhIJKlmNoPQRsTuvwxyZ`），请妥善保存。

2. **获取管理员的 Telegram User ID**
   - 在 Telegram 中搜索并打开 [@userinfobot](https://t.me/userinfobot)。
   - 点击 Start，它会回复你的 ID（一串纯数字，例如：`123456789`）。

3. **获取 Chatwoot Access Token 和 Account ID**
   - 登录你的 Chatwoot 后台。
   - 点击左下角头像 -> **Profile Settings** (个人设置)。
   - 滚动到页面最底部，找到 **Access Token** 并复制。
   - 查看浏览器地址栏，URL 格式通常为 `https://app.chatwoot.com/app/accounts/1/xxx`，其中的数字 `1` 就是你的 **Account ID**。

4. **准备 Telegram 话题群组（可选，但强烈推荐！）**
   - 在 Telegram 中创建一个新群组。
   - 将你刚才创建的 Bot 邀请进群，并**将其提升为管理员**（赋予所有权限，特别是 Manage Topics 权限）。
   - 点击群组顶部名称进入设置，点击右上角编辑（铅笔图标），找到 **Topics (话题/论坛)** 选项并**开启**。
   - 在群组中添加 [@RawDataBot](https://t.me/RawDataBot) 或使用第三方客户端，获取该群组的 Chat ID（通常以 `-100` 开头，例如：`-1001234567890`）。

### 第二步：服务器部署

登录你的服务器，执行以下命令：

```bash
# 1. 创建并进入项目目录
mkdir -p /opt/chatwoot-telegram-bot && cd /opt/chatwoot-telegram-bot

# 2. 创建数据目录
mkdir data

# 3. 创建环境变量文件
nano .env
```

将以下内容复制到 `.env` 文件中，并替换为你自己的真实数据：

```env
# 容器内部监听端口（保持 3000 即可，不要改动，端口映射在 docker-compose 中配置）
PORT=3000

# Telegram 配置
TELEGRAM_TOKEN=你的_Telegram_Bot_Token
TELEGRAM_ADMIN_ID=你的_Telegram_User_ID
# 如果你开启了群组话题模式，填入群组ID（强烈推荐）；如果只用单聊模式，将此行注释掉
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
# 可选：启动时丢弃堆积的 Telegram 更新。默认 false（重启窗口期不丢消息）。
# TELEGRAM_DROP_PENDING_UPDATES=false

# Chatwoot 配置
CHATWOOT_BASE_URL=https://你的chatwoot域名.com
CHATWOOT_ACCESS_TOKEN=你的_Chatwoot_Access_Token
CHATWOOT_ACCOUNT_ID=1

# 可选：Webhook 签名验证密钥（在 Chatwoot Webhook 设置中生成后填入）
# CHATWOOT_WEBHOOK_SECRET=your_webhook_secret

# 日志级别（debug / info / warn / error）
LOG_LEVEL=info

# 可选：日志写入文件 + 自动轮转
# LOG_TO_FILE=true            # 是否同时写入日志文件，默认 false（仅控制台）
# LOG_DIR=./logs              # 日志目录
# LOG_MAX_SIZE_MB=10          # 单文件大小上限，超过自动轮转
# LOG_MAX_FILES=3             # 保留的历史日志份数

# 可选：SQLite 数据库路径，默认 ./mappings.db（容器内 /app/data/mappings.db）
# DB_PATH=/app/data/mappings.db
```

#### 环境变量速查

| 变量 | 必填 | 默认值 | 说明 |
|---|:---:|---|---|
| `TELEGRAM_TOKEN` | ✅ | — | 从 @BotFather 获取的 Bot Token |
| `TELEGRAM_ADMIN_ID` | ✅ | — | 管理员 User ID（单聊模式必填） |
| `TELEGRAM_FORUM_CHAT_ID` | ⭕ | — | 话题群组 ID（推荐启用） |
| `TELEGRAM_DROP_PENDING_UPDATES` | ⭕ | `false` | 启动时是否丢弃堆积更新 |
| `CHATWOOT_BASE_URL` | ✅ | `https://app.chatwoot.com` | Chatwoot 后台地址（自动去尾斜杠） |
| `CHATWOOT_ACCESS_TOKEN` | ✅ | — | Personal Access Token |
| `CHATWOOT_ACCOUNT_ID` | ✅ | — | 账户 ID |
| `CHATWOOT_WEBHOOK_SECRET` | ⭕ | — | Webhook 签名密钥（强烈推荐设置） |
| `PORT` | ⭕ | `3000` | Webhook 监听端口 |
| `LOG_LEVEL` | ⭕ | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_TO_FILE` | ⭕ | `false` | 是否写入日志文件 |
| `LOG_DIR` | ⭕ | `./logs` | 日志目录 |
| `LOG_MAX_SIZE_MB` | ⭕ | `10` | 单个日志文件大小上限（MB） |
| `LOG_MAX_FILES` | ⭕ | `3` | 保留的历史日志数 |
| `DB_PATH` | ⭕ | `mappings.db` | SQLite 数据库路径 |
| `NODE_ENV` | ⭕ | — | 设为 `production` 启用 JSON 结构化日志 |

保存并退出（在 nano 中按 `Ctrl+O`, `Enter`, `Ctrl+X`）。

接着创建 `docker-compose.yml` 文件：

```bash
nano docker-compose.yml
```

填入以下内容：

```yaml
services:
  bot:
    image: ghcr.io/shannon-x/chatwoot-telegram-bot:latest
    container_name: telegram-chatwoot-bot
    restart: unless-stopped
    ports:
      # 宿主机端口:容器端口。如果你想用 3123 端口接收 Webhook，这里就写 3123:3000
      - "3123:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

启动服务：

```bash
docker compose up -d

# 检查日志，确认是否启动成功
docker compose logs -f bot
```
*如果日志中显示 `Webhook server running on port 3000` 且没有报错，说明启动成功。*

### 第三步：配置 Chatwoot Webhook

1. 登录 Chatwoot 后台。
2. 进入 **设置 (Settings) → 集成 (Integrations) → Webhooks**。
3. 点击 **"Add new webhook"**。
4. 配置 Webhook：
   - **Webhook URL**: `http://你的服务器IP:3123/webhook` （注意端口号要和 docker-compose.yml 暴露的宿主机端口一致。如果你配置了反向代理和域名，请填写 `https://你的域名/webhook`）。
   - **Events**: 勾选 `message_created` 和 `conversation_status_changed`。
5. 保存。
6. （可选但推荐）保存后，Chatwoot 会生成一个 Webhook Secret。你可以将其复制，填入服务器的 `.env` 文件中的 `CHATWOOT_WEBHOOK_SECRET` 变量，然后执行 `docker compose restart bot`，以开启签名验证，防止恶意伪造请求。

### ⚠️ 重要：Nginx 反向代理配置

如果你的 Webhook URL 使用了域名和 Nginx 反向代理，**必须**在 Nginx 配置中添加允许下划线 Header 的指令，否则下载附件时会报 401 错误：

```nginx
server {
    server_name 你的域名;

    # 必须开启：允许包含下划线的 HTTP Header (api_access_token)
    underscores_in_headers on;

    location / {
        proxy_pass http://127.0.0.1:3123;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

重载 Nginx：`sudo systemctl reload nginx`

---

## 📱 使用指南

### 🆕 话题隔离模式（Forum Topics）- 强烈推荐

这是最高效的客服工作方式。
1. 当 Chatwoot 有新客户发送消息时，Bot 会自动在你的 Telegram 群组中创建一个新的话题（Topic），名称格式为 `🗨️ 客户名 #对话ID`。
2. 你只需要点击进入该话题，**直接发送文字或图片**，消息就会自动同步给该客户。
3. 话题内支持使用 `/canned` 命令快速调用预设回复。
4. 消息下方会附带控制按钮，点击 **"✅ 标记已解决"**，Chatwoot 中的会话将被关闭，同时 Telegram 中的这个话题也会被自动关闭（归档）。

### 💬 普通单聊模式

如果你没有配置 `TELEGRAM_FORUM_CHAT_ID`，Bot 会直接私聊发消息给管理员。
- **回复客户时，必须在 Telegram 中长按客户的消息，选择“回复 (Reply)”，然后再输入内容。** 否则 Bot 无法知道你是在回复哪位客户。
- 同样支持点击按钮标记已解决或重新打开。

---

## ❓ 常见问题排查

**1. 机器人没有在群组里创建话题？**
- 检查群组是否开启了 "Topics (话题)" 功能（群组设置中开启）。
- 检查 Bot 是否是群组管理员，且拥有 "Manage Topics (管理话题)" 权限。
- 检查 `.env` 中的 `TELEGRAM_FORUM_CHAT_ID` 是否填写正确（通常带 `-100` 前缀）。

**2. 日志报错 `Error: 409: Conflict: terminated by other getUpdates request`**
- 说明你有两个相同的 Bot 实例在同时运行。请确保你没有在其他服务器或后台使用 `node` 运行同一个 Bot Token。执行 `docker ps` 检查是否有重复容器。

**3. Webhook 无法接收消息？**
- 检查 Chatwoot 后台填写的 Webhook URL 端口是否与 `docker-compose.yml` 中映射的外部端口一致。
- 检查服务器防火墙（如 ufw、宝塔面板、云服务商安全组）是否放行了该端口。
- 检查 `.env` 中的 `PORT` 必须保持为 `3000`（这是容器内部监听端口，不要改成外部端口）。

**4. 无法发送/接收图片附件？**
- 如果使用了 Nginx 反向代理 Chatwoot，请务必在 Nginx 配置中加上 `underscores_in_headers on;`。

## 🏗️ 技术架构

- **运行时**: Node.js 20 (Alpine)
- **语言**: TypeScript
- **框架**: Telegraf (Telegram Bot), Express (Webhook Server)
- **数据库**: SQLite3 (持久化消息映射)

## 🤝 贡献与支持

欢迎提交 Issue 和 Pull Request！如果这个项目对您有帮助，请给个 ⭐ Star！

MIT License © 2025 [Shannon-x](https://github.com/Shannon-x)
