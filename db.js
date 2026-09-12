// db.js
require('dotenv').config();
const { createClient } = require('@libsql/client');
const bcrypt = require('bcrypt');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  // ==================== 用户表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      is_approved INTEGER DEFAULT 1,
      role TEXT DEFAULT 'user'
    )
  `);

  const userColumnsResult = await db.execute("PRAGMA table_info(users)");
  const userColumns = userColumnsResult.rows.map(col => col.name);
  if (!userColumns.includes('email')) {
    await db.execute("ALTER TABLE users ADD COLUMN email TEXT");
    await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)");
  }
  if (!userColumns.includes('is_approved')) {
    await db.execute("ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 1");
  }
  if (!userColumns.includes('role')) {
    await db.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
  }

  // ==================== 谜题表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS puzzles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '未命名',
      tags TEXT,
      description TEXT,
      answer TEXT NOT NULL,
      flavor_text TEXT,
      is_visible INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const puzzleColumnsResult = await db.execute("PRAGMA table_info(puzzles)");
  const puzzleColumns = puzzleColumnsResult.rows.map(col => col.name);
  if (!puzzleColumns.includes('name')) {
    await db.execute("ALTER TABLE puzzles ADD COLUMN name TEXT NOT NULL DEFAULT '未命名'");
  }
  if (!puzzleColumns.includes('tags')) {
    await db.execute("ALTER TABLE puzzles ADD COLUMN tags TEXT");
  }
  if (!puzzleColumns.includes('flavor_text')) {
    await db.execute("ALTER TABLE puzzles ADD COLUMN flavor_text TEXT");
  }
  if (!puzzleColumns.includes('is_visible')) {
    await db.execute("ALTER TABLE puzzles ADD COLUMN is_visible INTEGER DEFAULT 1");
  }

  // ==================== 中间答案表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS intermediate_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      puzzle_id INTEGER NOT NULL,
      answer TEXT NOT NULL,
      info TEXT,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
    )
  `);

  const interColumnsResult = await db.execute("PRAGMA table_info(intermediate_answers)");
  const interColumns = interColumnsResult.rows.map(col => col.name);
  if (!interColumns.includes('sort_order')) {
    await db.execute("ALTER TABLE intermediate_answers ADD COLUMN sort_order INTEGER DEFAULT 0");
  }
  if (!interColumns.includes('info')) {
    await db.execute("ALTER TABLE intermediate_answers ADD COLUMN info TEXT");
  }

  // ==================== 提示表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      puzzle_id INTEGER NOT NULL,
      title TEXT,
      hint_text TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      point_cost INTEGER DEFAULT 0,
      FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
    )
  `);

  const hintColumnsResult = await db.execute("PRAGMA table_info(hints)");
  const hintColumns = hintColumnsResult.rows.map(col => col.name);
  if (!hintColumns.includes('title')) {
    await db.execute("ALTER TABLE hints ADD COLUMN title TEXT");
  }
  if (!hintColumns.includes('sort_order')) {
    await db.execute("ALTER TABLE hints ADD COLUMN sort_order INTEGER DEFAULT 0");
  }
  if (!hintColumns.includes('point_cost')) {
    await db.execute("ALTER TABLE hints ADD COLUMN point_cost INTEGER DEFAULT 0");
  }

  // ==================== 比赛表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS competitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      hint_points_per_minute REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const compColumnsResult = await db.execute("PRAGMA table_info(competitions)");
  const compColumns = compColumnsResult.rows.map(col => col.name);
  if (!compColumns.includes('hint_points_per_minute')) {
    await db.execute("ALTER TABLE competitions ADD COLUMN hint_points_per_minute REAL DEFAULT 0");
  }

  // ==================== 比赛-题目关联表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS competition_puzzles (
      competition_id INTEGER NOT NULL,
      puzzle_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      unlock_puzzle_ids TEXT,
      unlock_required_count INTEGER DEFAULT 0,
      is_meta INTEGER DEFAULT 0,
      PRIMARY KEY (competition_id, puzzle_id),
      FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
      FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
    )
  `);

  const cpColumnsResult = await db.execute("PRAGMA table_info(competition_puzzles)");
  const cpColumns = cpColumnsResult.rows.map(col => col.name);
  if (!cpColumns.includes('unlock_puzzle_ids')) {
    await db.execute("ALTER TABLE competition_puzzles ADD COLUMN unlock_puzzle_ids TEXT");
  }
  if (!cpColumns.includes('unlock_required_count')) {
    await db.execute("ALTER TABLE competition_puzzles ADD COLUMN unlock_required_count INTEGER DEFAULT 0");
  }
  if (!cpColumns.includes('is_meta')) {
    await db.execute("ALTER TABLE competition_puzzles ADD COLUMN is_meta INTEGER DEFAULT 0");
  }

  // ==================== 报名表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competition_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(competition_id, user_id),
      FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // ==================== 用户解答记录表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS competition_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competition_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      puzzle_id INTEGER NOT NULL,
      solved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(competition_id, user_id, puzzle_id),
      FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE
    )
  `);

  // ==================== 用户提示解锁表 ====================
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_hint_unlocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competition_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      puzzle_id INTEGER NOT NULL,
      hint_id INTEGER NOT NULL,
      cost INTEGER NOT NULL DEFAULT 0,
      unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(competition_id, user_id, puzzle_id, hint_id),
      FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE CASCADE,
      FOREIGN KEY (hint_id) REFERENCES hints(id) ON DELETE CASCADE
    )
  `);

  // ==================== 处理 root 用户 ====================
  const rootUserResult = await db.execute({
    sql: 'SELECT * FROM users WHERE username = ?',
    args: ['root']
  });
  const rootUser = rootUserResult.rows[0];
  if (!rootUser) {
    const rootPassword = process.env.ROOT_PASSWORD || 'Jzia#92*kzxp';
    const saltRounds = 10;
    const passwordHash = bcrypt.hashSync(rootPassword, saltRounds);
    await db.execute({
      sql: 'INSERT INTO users (username, email, password_hash, is_approved, role) VALUES (?, ?, ?, 1, ?)',
      args: ['root', 'root@example.com', passwordHash, 'root']
    });
    console.log('已创建 root 账号');
  } else {
    if (bcrypt.compareSync('root123', rootUser.password_hash) || bcrypt.compareSync('Jzia#92*kzxp', rootUser.password_hash)) {
      const newRootPassword = process.env.ROOT_PASSWORD || 'Jzia#92*kzxp';
      const saltRounds = 10;
      const newPasswordHash = bcrypt.hashSync(newRootPassword, saltRounds);
      await db.execute({
        sql: 'UPDATE users SET password_hash = ?, is_approved = 1, role = ? WHERE username = ?',
        args: [newPasswordHash, 'root', 'root']
      });
      console.log('已重置 root 密码');
    }
  }
}

module.exports = { db, initDB };