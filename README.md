# Follow-Flow Puzzle Hunt

一个简单的谜题管理 Web 应用，支持 root 账号登录并添加 PH 类型谜题。

## 功能
- 登录系统（仅 root 账号）
- 添加谜题（图片 URL、文字题面、答案、中间答案、提示）
- 查看所有谜题列表

## 技术栈
- Node.js
- Express
- EJS
- SQLite (better-sqlite3)
- bcrypt
- express-session

## 快速开始

### 1. 安装依赖
```bash
npm install