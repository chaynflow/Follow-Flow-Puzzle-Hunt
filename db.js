// db.js
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

// 创建或打开数据库文件
const db = new Database('puzzle-hunt.db');

// 启用外键约束（用于级联删除）
db.pragma('foreign_keys = ON');

// 创建 users 表（新结构）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    is_approved INTEGER DEFAULT 1,
    role TEXT DEFAULT 'user'
  )
`);

// 获取 users 表现有列
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(col => col.name);

// 如果缺少 email 列，先添加列（不带 UNIQUE），再创建唯一索引
if (!userColumns.includes('email')) {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)");
}

// 如果缺少 is_approved 列，添加
if (!userColumns.includes('is_approved')) {
  db.exec("ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 1");
}

// 如果缺少 role 列，添加
if (!userColumns.includes('role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
}

// 创建 puzzles 表（新结构：不再包含 image_url，增加 name 和 tags）
db.exec(`
  CREATE TABLE IF NOT EXISTS puzzles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '未命名',
    tags TEXT,
    description TEXT,
    answer TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 获取 puzzles 表现有列，若存在旧结构则迁移
const puzzleColumns = db.prepare("PRAGMA table_info(puzzles)").all().map(col => col.name);
if (!puzzleColumns.includes('name')) {
  db.exec("ALTER TABLE puzzles ADD COLUMN name TEXT NOT NULL DEFAULT '未命名'");
}
if (!puzzleColumns.includes('tags')) {
  db.exec("ALTER TABLE puzzles ADD COLUMN tags TEXT");
}
// 注意：如果旧表中有 image_url 列，我们保留但不使用，不影响功能

// 创建中间答案表
db.exec(`
  CREATE TABLE IF NOT EXISTS intermediate_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_id INTEGER NOT NULL,
    answer TEXT NOT NULL,
    info TEXT,
    FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
  )
`);

// 创建提示表
db.exec(`
  CREATE TABLE IF NOT EXISTS hints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_id INTEGER NOT NULL,
    hint_text TEXT NOT NULL,
    FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
  )
`);

// 处理 root 用户
const rootUser = db.prepare('SELECT * FROM users WHERE username = ?').get('root');
if (!rootUser) {
  // 创建 root 账号，密码为 Jzia#92*kzxp
  const saltRounds = 10;
  const passwordHash = bcrypt.hashSync('Jzia#92*kzxp', saltRounds);
  db.prepare('INSERT INTO users (username, email, password_hash, is_approved, role) VALUES (?, ?, ?, 1, ?)')
    .run('root', 'root@example.com', passwordHash, 'root');
  console.log('已创建默认 root 账号');
} else {
  // 如果 root 存在且密码是旧默认值 root123，则更新为新密码
  const oldPasswordHash = rootUser.password_hash;
  if (bcrypt.compareSync('root123', oldPasswordHash)) {
    const saltRounds = 10;
    const newPasswordHash = bcrypt.hashSync('Jzia#92*kzxp', saltRounds);
    db.prepare('UPDATE users SET password_hash = ?, is_approved = 1, role = ? WHERE username = ?')
      .run(newPasswordHash, 'root', 'root');
    console.log('已将 root 密码更新为新的强密码');
  }
  // 如果 root 缺少 role 或 is_approved，补全
  if (rootUser.role !== 'root' || !rootUser.is_approved) {
    db.prepare('UPDATE users SET role = ?, is_approved = 1 WHERE username = ?')
      .run('root', 'root');
  }
}

module.exports = db;