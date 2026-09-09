# Follow-Flow Puzzle Hunt

一个基于 Node.js 的谜题管理与答题平台。支持用户注册、管理员审核、题目管理、多级提示、中间答案验证等功能。适用于线上谜题活动、寻宝游戏等场景。

## 功能特性

- **用户系统**  
  - 用户注册（用户名、邮箱、密码）  
  - 管理员（root/admin）审核新用户  
  - 角色分为 `root`、`admin`、`user`，权限逐级递减  
  - root 可以提升/取消用户为管理员，管理员拥有除设置管理员外的所有管理权限

- **谜题管理**  
  - 添加/编辑/删除谜题  
  - 支持题目名称、标签、风味文本、描述、答案、可见性  
  - 描述和风味文本支持 Markdown 图片语法 `![alt](url)`  
  - 支持多个中间答案（可附带对应提示信息）  
  - 支持多级提示（每级包含标题和内容），查看提示前需确认  
  - 可控制题目是否对普通用户可见

- **答题功能**  
  - 普通用户可浏览可见题目并提交答案  
  - 答案匹配忽略大小写和首尾空格  
  - 若提交为中间答案，显示对应信息（若有）  
  - 若提交为最终答案，显示正确反馈

- **界面**  
  - 谜题列表按创建时间倒序  
  - 普通用户列表不显示隐藏题目和答案等信息  
  - 提示内容默认隐藏，点击按钮确认后显示

## 技术栈

- **后端**: Node.js + Express
- **数据库**: Turso（基于 libSQL 的云数据库，兼容 SQLite 协议）
- **模板引擎**: EJS
- **认证**: express-session + bcrypt
- **Markdown 图片解析**: 自定义简单正则替换为 `<img>` 标签

## 快速开始（本地运行）

### 1. 环境要求

- Node.js 18 或更高版本
- npm

### 2. 克隆仓库

```bash
git clone https://github.com/你的用户名/Follow-Flow-Puzzle-Hunt.git
cd Follow-Flow-Puzzle-Hunt
```

### 3. 安装依赖

```bash
npm install
```

### 4. 配置环境变量

在项目根目录创建 `.env` 文件，内容如下：

```env
TURSO_DATABASE_URL=libsql://your-database-name.turso.io
TURSO_AUTH_TOKEN=your-auth-token
SESSION_SECRET=一个随机字符串用于会话加密
ROOT_PASSWORD=你想要设置的root密码（建议使用强密码）
PORT=3000
```

> **获取 Turso 数据库凭证**：  
> 1. 注册并登录 [Turso](https://turso.tech/app)  
> 2. 创建一个数据库（如 `puzzle-hunt`）  
> 3. 在数据库详情页获取 URL 和生成 Auth Token

**注意：不要将 `.env` 提交到 Git。**

### 5. 启动应用

```bash
node app.js
```

访问 `http://localhost:3000` 即可看到登录页面。

## 线上部署（Render + Turso）

推荐使用 [Render](https://render.com) 托管应用，数据存储在 Turso 云数据库，无需持久磁盘。

1. 将代码推送到 GitHub 仓库。  
2. 在 Render 中创建新的 Web Service，选择该仓库。  
3. 配置环境变量（同本地）。  
4. 设置 Build Command: `npm install`  
5. 设置 Start Command: `node app.js`  
6. 部署完成后即可通过 Render 提供的 URL 访问。

## 环境变量说明

| 变量名                 | 必填 | 说明 |
|------------------------|------|------|
| `TURSO_DATABASE_URL`   | 是   | Turso 数据库 URL，格式如 `libsql://xxx.turso.io` |
| `TURSO_AUTH_TOKEN`     | 是   | Turso 认证令牌 |
| `SESSION_SECRET`       | 是   | 会话加密密钥，建议使用随机字符串 |
| `ROOT_PASSWORD`        | 可选 | root 账号密码，若不设置则使用默认值 `Jzia#92*kzxp`（生产环境务必设置） |
| `PORT`                 | 可选 | 应用监听端口，默认 3000 |

## 账号角色与权限

| 功能 | root | admin | user |
|------|------|-------|------|
| 查看可见题目 | ✅ | ✅ | ✅ |
| 提交答案 | ✅ | ✅ | ✅ |
| 添加/编辑/删除题目 | ✅ | ✅ | ❌ |
| 切换题目可见性 | ✅ | ✅ | ❌ |
| 查看题目答案和管理信息 | ✅ | ✅ | ❌ |
| 批准/删除用户 | ✅ | ✅（仅可删除普通用户） | ❌ |
| 设置/取消管理员 | ✅ | ❌ | ❌ |

## 使用指南

### 添加题目

管理员登录后，点击仪表板上的“添加新谜题”按钮，进入独立表单页。填写以下字段：

- **题目名称**：必填  
- **标签**：可选，多个标签用逗号分隔（例如 `数学,逻辑`）  
- **风味文本**：可选，显示在标题之后，支持 Markdown 图片  
- **文字题面**：可选，支持 Markdown 图片  
- **答案**：必填  
- **可见**：是否对普通用户显示  
- **中间答案**：可添加多个，每个包括答案和对应信息  
- **提示**：可添加多个，每个包括标题和内容，内容支持 Markdown 图片

### Markdown 图片语法

在描述、风味文本和提示内容中，使用以下格式插入外部图片：

```
![图片描述](https://example.com/image.jpg)
```

渲染时会自动转换为 `<img>` 标签，并自适应宽度。

### 答题流程

普通用户登录后，在谜题列表点击“查看详情 & 提交答案”，进入详情页。  
- 输入答案提交，系统会进行匹配。  
- 若为最终答案，显示正确提示。  
- 若为某个中间答案，显示该中间答案对应的信息（若有）。  
- 若错误，显示错误提示。

提示内容默认隐藏，点击“显示提示X”按钮后需确认才会显示。

## 数据模型

数据库使用 Turso，表结构如下：

### users
- `id`：主键  
- `username`：唯一用户名  
- `email`：唯一邮箱  
- `password_hash`：bcrypt 哈希密码  
- `is_approved`：是否审核通过（0/1）  
- `role`：角色（root/admin/user）

### puzzles
- `id`：主键  
- `name`：题目名称  
- `tags`：标签  
- `description`：题面  
- `answer`：最终答案  
- `flavor_text`：风味文本  
- `is_visible`：是否可见（0/1）  
- `created_at`：创建时间

### intermediate_answers
- `id`：主键  
- `puzzle_id`：关联谜题  
- `answer`：中间答案  
- `info`：对应信息  
- `sort_order`：排序

### hints
- `id`：主键  
- `puzzle_id`：关联谜题  
- `title`：提示标题  
- `hint_text`：提示内容  
- `sort_order`：排序

外键启用了 `ON DELETE CASCADE`，删除谜题会级联删除相关中间答案和提示。

## 项目结构

```
Follow-Flow-Puzzle-Hunt/
├── app.js               # 主服务器和路由
├── db.js                # 数据库初始化和迁移
├── views/
│   ├── login.ejs        # 登录页
│   ├── register.ejs     # 注册页
│   ├── dashboard.ejs    # 仪表板（题目列表）
│   ├── puzzle.ejs       # 题目详情和答题
│   ├── puzzle_form.ejs  # 添加/编辑题目表单
│   └── admin_users.ejs  # 用户管理页
├── .env.example         # 环境变量模板
├── .gitignore
├── package.json
└── README.md
```

## 后续计划（可选）

- 题目分类和过滤  
- 答题进度记录  
- 更多 Markdown 语法支持（加粗、链接等）  
- 用户自行修改密码功能  
- 更细粒度的权限控制

---

如有问题或建议，欢迎提交 Issue 或 Pull Request。
