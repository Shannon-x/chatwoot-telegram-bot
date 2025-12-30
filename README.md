# Chatwoot Telegram Bot Bridge

<div align="center">

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-shannon--x%2Fchatwoot--telegram--bot-blue?logo=github)](https://github.com/Shannon-x/chatwoot-telegram-bot/pkgs/container/chatwoot-telegram-bot)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/Shannon-x/chatwoot-telegram-bot/docker-build.yml?branch=main&label=Docker%20Build)](https://github.com/Shannon-x/chatwoot-telegram-bot/actions)
[![License](https://img.shields.io/github/license/Shannon-x/chatwoot-telegram-bot)](./LICENSE)

一个轻量级的 Chatwoot 和 Telegram 双向消息桥接服务

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [配置说明](#-配置说明) • [使用指南](#-使用指南) • [常见问题](#-常见问题)

</div>

---

## 📖 简介

这是一个连接 **Chatwoot** 和 **Telegram** 的中间件机器人。通过 Telegram Bot 直接接收和回复 Chatwoot 中的客户消息，让客服团队可以在 Telegram 中高效处理客户咨询。

## ✨ 功能特性

- 🔄 **双向消息同步**
  - Chatwoot 客户消息 → 实时推送到 Telegram
  - Telegram 回复 → 自动同步到 Chatwoot 发送给客户

- 👥 **多会话管理**
  - 通过消息引用机制，完美支持多个客户同时对话
  - SQLite 数据库持久化消息映射关系

- 💬 **Forum Topics 会话隔离**（新功能）
  - 每个客户对话自动创建独立话题
  - 彻底解决多用户同时对话时消息混乱问题
  - 对话结束时自动关闭话题
  - 每条消息附带操作按钮（标记已解决、重新打开、查看详情）

- 🎯 **便捷操作**
  - 一键标记会话为"已解决"
  - 一键重新打开已关闭的会话
  - 快速跳转到 Chatwoot 查看完整对话历史

- 🤖 **AI 消息支持**
  - 区分客户消息和 AI/客服回复
  - 支持转发 AI Agent 的自动回复

- 🌐 **完全中文化**
  - 所有界面和提示均为中文
  - 更符合中文用户使用习惯

- 🐳 **开箱即用**
  - Docker 一键部署
  - 自动构建和发布到 GitHub Container Registry

## 🚀 快速开始

### 方式一：使用 GitHub Packages 镜像（推荐）

1️⃣ **创建配置文件**

```bash
# 创建项目目录
mkdir chatwoot-telegram-bot && cd chatwoot-telegram-bot

# 创建 .env 文件
cat > .env << EOF
PORT=3000
TELEGRAM_TOKEN=你的_telegram_bot_token
TELEGRAM_ADMIN_ID=你的_telegram_user_id
CHATWOOT_ACCESS_TOKEN=你的_chatwoot_access_token
CHATWOOT_BASE_URL=https://你的chatwoot域名
CHATWOOT_ACCOUNT_ID=1
EOF

# 创建数据目录
mkdir data
```

2️⃣ **创建 docker-compose.yml**

```yaml
services:
  bot:
    image: ghcr.io/shannon-x/chatwoot-telegram-bot:latest
    container_name: chatwoot-telegram-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

3️⃣ **启动服务**

```bash
docker compose up -d
```

### 方式二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/Shannon-x/chatwoot-telegram-bot.git
cd chatwoot-telegram-bot

# 配置环境变量
cp .env.example .env
nano .env  # 编辑配置

# 构建并启动
docker compose up -d --build
```

## ⚙️ 配置说明

### 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `PORT` | 服务监听端口（容器内部） | `3000` |
| `TELEGRAM_TOKEN` | Telegram Bot Token | 从 [@BotFather](https://t.me/BotFather) 获取 |
| `TELEGRAM_ADMIN_ID` | 管理员 Telegram User ID | 从 [@userinfobot](https://t.me/userinfobot) 获取 |
| `CHATWOOT_ACCESS_TOKEN` | Chatwoot API 访问令牌 | 在 Profile Settings → Access Token 获取 |
| `CHATWOOT_BASE_URL` | Chatwoot 实例地址 | `https://app.chatwoot.com` |
| `CHATWOOT_ACCOUNT_ID` | Chatwoot 账户 ID | 通常为 `1` |
| `TELEGRAM_FORUM_CHAT_ID` | Forum 群组 ID（可选） | 启用话题隔离功能 |

### 获取 Telegram Bot Token

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 命令创建新机器人
3. 按提示设置机器人名称和用户名
4. 复制返回的 API Token

### 获取 Telegram User ID

1. 在 Telegram 中搜索 [@userinfobot](https://t.me/userinfobot)
2. 点击 Start 或发送任意消息
3. 复制返回的 `Id` 数字

### 获取 Chatwoot Access Token

1. 登录 Chatwoot
2. 点击左下角头像 → **Profile Settings**
3. 滚动到页面底部找到 **Access Token**
4. 复制 Token（需要管理员权限）

### 配置 Chatwoot Webhook

1. 登录 Chatwoot 后台
2. 进入 **设置 → 集成 → Webhooks**
3. 点击 **"Add new webhook"**
4. 配置 Webhook：
   - **Webhook URL**: `http://你的服务器IP:3000/webhook`
   - **Events**: 勾选 `message_created` 和 `conversation_status_changed`
5. 保存

### ⚠️ 重要：Nginx 配置

如果您的 Chatwoot 使用 Nginx 反向代理，需要添加以下配置：

```nginx
server {
    server_name 你的域名;

    # 允许包含下划线的 HTTP Header
    underscores_in_headers on;

    # 传递 API 认证 Header
    location / {
        proxy_set_header api_access_token $http_api_access_token;
        # ... 其他配置
    }
}
```

重载 Nginx：
```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 📱 使用指南

### 🆕 启用 Forum Topics（话题隔离模式）

为解决多用户同时对话时消息混乱的问题，可启用 Telegram Forum Topics 功能：

**前提条件：**
1. 创建一个 Telegram **超级群组**
2. 在群组设置中启用 **Topics**（话题）功能
3. 将 Bot 添加为群组**管理员**，并授予 `can_manage_topics` 权限

**配置步骤：**

1. 获取群组 Chat ID（可通过 [@RawDataBot](https://t.me/RawDataBot) 获取，通常为 `-100xxxxxxxxxx` 格式）
2. 在 `.env` 中添加：
   ```bash
   TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
   ```
3. 确保 Chatwoot Webhook 勾选了 `conversation_status_changed` 事件
4. 重启服务

**使用说明：**
- 新客户消息会自动在群组中创建话题（格式：`🗨️ 客户名 #对话ID`）
- 在话题内直接发送消息即可回复客户（无需引用）
- 每条消息都有操作按钮：
  - **✅ 标记已解决** - 标记对话为已解决并自动关闭话题
  - **🔓 重新打开** - 重新打开已关闭的对话和话题
  - **📱 在 Chatwoot 中查看** - 跳转到 Chatwoot 查看完整对话

---

### 接收客户消息

当 Chatwoot 收到客户消息时，您会在 Telegram 收到：

```
👤 张三 (zhangsan@example.com)
💬 你好，我需要帮助

[✅ 标记已解决] [🔓 重新打开]
[📱 在 Chatwoot 中查看]
```

### 回复客户

**Forum 模式：** 在话题内直接发送消息即可

**普通模式：** 在 Telegram 中**回复**（Reply）机器人发送的消息，输入您的回复内容

消息会自动发送到 Chatwoot 并推送给客户。

### 标记会话已解决

点击消息下方的 **"✅ 标记已解决"** 按钮，会话将在 Chatwoot 中被标记为已解决，Forum 话题会自动关闭。

### 重新打开会话

点击 **"🔓 重新打开"** 按钮，可以重新打开已解决的会话，Forum 话题也会重新打开。

### 查看完整对话

点击 **"📱 在 Chatwoot 中查看"** 按钮，直接跳转到 Chatwoot 查看完整对话历史。

## 🔧 管理服务

```bash
# 查看日志
docker compose logs -f

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 更新到最新版本
docker compose pull
docker compose up -d
```

## ❓ 常见问题

### 1. 为什么无法回复消息？（401 错误）

**原因**：Nginx 默认会丢弃包含下划线的 HTTP Header

**解决方案**：在 Nginx 配置中添加 `underscores_in_headers on;`（详见[配置说明](#️-重要nginx-配置)）

### 2. 如何获取 Telegram User ID？

使用 [@userinfobot](https://t.me/userinfobot) 获取您的 User ID

### 3. Webhook 没有收到消息怎么办？

检查：
- Chatwoot Webhook 配置是否正确
- 服务器防火墙是否开放 3000 端口
- 查看服务日志：`docker compose logs -f`

### 4. 如何支持多个管理员？

目前仅支持单个管理员。如需多管理员支持，建议启用 Forum Topics 模式，将多个管理员添加到群组中。

### 5. 数据库文件在哪里？

SQLite 数据库文件位于 `./data/mappings.db`，用于存储消息映射关系。

## 🏗️ 技术架构

- **运行时**: Node.js 20 (Alpine)
- **语言**: TypeScript
- **框架**:
  - Telegraf (Telegram Bot)
  - Express (Webhook Server)
- **数据库**: SQLite3
- **容器**: Docker
- **镜像仓库**: GitHub Container Registry (ghcr.io)

## 📦 项目结构

```
chatwoot-telegram-bot/
├── src/
│   ├── index.ts         # 应用入口
│   ├── config.ts        # 配置管理
│   ├── bot.ts           # Telegram Bot 逻辑
│   ├── server.ts        # Webhook 服务器
│   ├── chatwoot.ts      # Chatwoot API 客户端
│   └── database.ts      # 数据库操作
├── Dockerfile           # Docker 镜像构建
├── docker-compose.yml   # Docker Compose 配置
├── package.json         # 项目依赖
└── tsconfig.json        # TypeScript 配置
```

## 🔄 自动更新

项目配置了 GitHub Actions，每次推送到 `main` 分支时会自动：
1. 构建 Docker 镜像
2. 推送到 GitHub Container Registry (ghcr.io)
3. 标记为 `latest`

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License © 2025 [Shannon-x](https://github.com/Shannon-x)

---

<div align="center">

**如果这个项目对您有帮助，请给个 ⭐ Star！**

Made with ❤️ by [Shannon-x](https://github.com/Shannon-x)

</div>
