// app.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { db, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 辅助函数：HTML 转义
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

// 辅助函数：将 Markdown 图片语法转换为 <img> 标签，其余文本转义
function renderMarkdownImages(text) {
  if (!text) return '';
  const parts = [];
  let lastIndex = 0;
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const before = text.substring(lastIndex, match.index);
    parts.push(escapeHtml(before));
    const alt = escapeHtml(match[1]);
    const url = escapeHtml(match[2]);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      parts.push(`<img src="${url}" alt="${alt}" style="max-width:100%;" />`);
    } else {
      parts.push(escapeHtml(match[0]));
    }
    lastIndex = regex.lastIndex;
  }
  const tail = text.substring(lastIndex);
  parts.push(escapeHtml(tail));
  return parts.join('');
}

// 辅助函数：计算提示点
function calculateHintPoints(competition, registeredAt, now = new Date()) {
  if (!competition || !registeredAt) return 0;
  const rate = competition.hint_points_per_minute || 0;
  if (rate <= 0) return 0;

  const start = new Date(competition.start_time);
  const end = new Date(competition.end_time);
  const current = now instanceof Date ? now : new Date(now);
  const regTime = new Date(registeredAt);

  if (current < start || regTime > current) return 0;

  const effectiveStart = regTime > start ? regTime : start;
  const effectiveEnd = current < end ? current : end;

  if (effectiveStart >= effectiveEnd) return 0;

  const minutesElapsed = (effectiveEnd - effectiveStart) / 60000;
  const points = minutesElapsed * rate;
  return Math.round(points * 100) / 100;
}

// 辅助函数：获取用户可用提示点（扣除已消耗）
async function getUserAvailableHintPoints(competitionId, userId) {
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [competitionId]
  });
  if (compResult.rows.length === 0) return null;
  const competition = compResult.rows[0];

  const regResult = await db.execute({
    sql: 'SELECT registered_at FROM registrations WHERE competition_id = ? AND user_id = ?',
    args: [competitionId, userId]
  });
  if (regResult.rows.length === 0) return null;
  const registeredAt = regResult.rows[0].registered_at;

  const totalEarned = calculateHintPoints(competition, registeredAt);

  const hintSpentResult = await db.execute({
    sql: 'SELECT COALESCE(SUM(cost), 0) AS total FROM user_hint_unlocks WHERE competition_id = ? AND user_id = ?',
    args: [competitionId, userId]
  });
  const hintSpent = hintSpentResult.rows[0].total;

  const attemptSpentResult = await db.execute({
    sql: 'SELECT COALESCE(SUM(cost), 0) AS total FROM user_attempt_purchases WHERE competition_id = ? AND user_id = ?',
    args: [competitionId, userId]
  });
  const attemptSpent = attemptSpentResult.rows[0].total;

  const inboxSpentResult = await db.execute({
    sql: 'SELECT COALESCE(SUM(cost), 0) AS total FROM user_inbox_purchases WHERE competition_id = ? AND user_id = ?',
    args: [competitionId, userId]
  });
  const inboxSpent = inboxSpentResult.rows[0].total;

  return totalEarned - hintSpent - attemptSpent - inboxSpent;
}

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// 认证中间件
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.redirect('/login');
}

function requireStaff(req, res, next) {
  if (req.session && (req.session.role === 'root' || req.session.role === 'admin')) {
    return next();
  }
  res.status(403).send('无权限访问');
}

function requireRoot(req, res, next) {
  if (req.session && req.session.role === 'root') {
    return next();
  }
  res.status(403).send('无权限访问');
}

// 初始化数据库
initDB()
  .then(() => console.log('数据库初始化完成'))
  .catch(err => {
    console.error('数据库初始化失败:', err);
    process.exit(1);
  });

// 首页
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// 注册页面
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

// 注册处理
// 注册处理
app.post('/register', async (req, res) => {
  const { username, email, password, confirm_password } = req.body;
  if (!username || !email || !password || !confirm_password) {
    return res.render('register', { error: '所有字段均为必填' });
  }
  if (username.length > 20) {
    return res.render('register', { error: '用户名长度不能超过 20 个字符' });
  }
  if (password.length < 8 || password.length > 20) {
    return res.render('register', { error: '密码长度必须在 8 到 20 个字符之间' });
  }
  if (password !== confirm_password) {
    return res.render('register', { error: '两次输入的密码不一致' });
  }

  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE username = ?',
    args: [username]
  });
  if (userResult.rows.length > 0) {
    return res.render('register', { error: '用户名已存在' });
  }

  const emailResult = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ?',
    args: [email]
  });
  if (emailResult.rows.length > 0) {
    return res.render('register', { error: '邮箱已被注册' });
  }

  const saltRounds = 10;
  const passwordHash = bcrypt.hashSync(password, saltRounds);
  await db.execute({
    sql: 'INSERT INTO users (username, email, password_hash, is_approved, role) VALUES (?, ?, ?, 0, ?)',
    args: [username, email, passwordHash, 'user']
  });

  res.redirect('/login?registered=1');
});

// 登录页面
app.get('/login', (req, res) => {
  const registered = req.query.registered === '1';
  res.render('login', { error: null, registered });
});

// 登录处理
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '用户名和密码不能为空', registered: false });
  }

  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE username = ?',
    args: [username]
  });
  const user = userResult.rows[0];
  if (!user) {
    return res.render('login', { error: '用户不存在', registered: false });
  }

  const passwordMatch = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatch) {
    return res.render('login', { error: '密码错误', registered: false });
  }

  if (!user.is_approved) {
    return res.render('login', { error: '账号尚未审核，请等待管理员批准', registered: false });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.redirect('/dashboard');
});

// 登出
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// 仪表板
app.get('/dashboard', requireAuth, async (req, res) => {
  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;
  let puzzlesResult;
  if (isStaff) {
    puzzlesResult = await db.execute(`
      SELECT p.*,
             (SELECT COUNT(*) FROM intermediate_answers ia WHERE ia.puzzle_id = p.id) AS inter_count,
             (SELECT COUNT(*) FROM hints h WHERE h.puzzle_id = p.id) AS hint_count
      FROM puzzles p
      ORDER BY p.created_at DESC
    `);
  } else {
    puzzlesResult = await db.execute(`
      SELECT p.*,
             (SELECT COUNT(*) FROM intermediate_answers ia WHERE ia.puzzle_id = p.id) AS inter_count,
             (SELECT COUNT(*) FROM hints h WHERE h.puzzle_id = p.id) AS hint_count
      FROM puzzles p
      WHERE p.is_visible = 1
      ORDER BY p.created_at DESC
    `);
  }
  const puzzles = puzzlesResult.rows;
  res.render('dashboard', {
    username: req.session.username,
    puzzles,
    isRoot,
    isAdmin,
    isStaff,
    userRole: req.session.role
  });
});

// 显示添加新谜题页面（staff）
app.get('/puzzles/new', requireAuth, requireStaff, (req, res) => {
  res.render('puzzle_form', {
    puzzle: null,
    intermediateAnswers: [],
    hints: [],
    isEdit: false,
    username: req.session.username,
    isStaff: true
  });
});

// 处理添加谜题（staff）
app.post('/puzzles', requireAuth, requireStaff, async (req, res) => {
  const {
    name = '',
    tags = '',
    description = '',
    answer,
    flavor_text = '',
    is_visible,
    inter_answers = [],
    inter_infos = [],
    hint_titles = [],
    hint_texts = [],
    point_cost = []
  } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).send('题目名称不能为空');
  }
  if (!answer || answer.trim() === '') {
    return res.status(400).send('答案不能为空');
  }

  const visibility = is_visible === 'on' ? 1 : 0;

  const insertResult = await db.execute({
    sql: 'INSERT INTO puzzles (name, tags, description, answer, flavor_text, is_visible) VALUES (?, ?, ?, ?, ?, ?)',
    args: [name.trim(), tags.trim(), description.trim(), answer.trim(), flavor_text.trim(), visibility]
  });
  const puzzleId = insertResult.lastInsertRowid;

  // 插入中间答案
  if (Array.isArray(inter_answers) && inter_answers.length > 0) {
    for (let i = 0; i < inter_answers.length; i++) {
      const ans = inter_answers[i];
      if (ans && ans.trim() !== '') {
        const info = inter_infos[i] || '';
        await db.execute({
          sql: 'INSERT INTO intermediate_answers (puzzle_id, answer, info, sort_order) VALUES (?, ?, ?, ?)',
          args: [puzzleId, ans.trim(), info.trim(), i]
        });
      }
    }
  }

  // 插入提示
  if (Array.isArray(hint_texts) && hint_texts.length > 0) {
    for (let i = 0; i < hint_texts.length; i++) {
      const hintText = hint_texts[i];
      if (hintText && hintText.trim() !== '') {
        const hintTitle = (hint_titles[i] || '').trim();
        const cost = parseInt(point_cost[i], 10) || 0;
        await db.execute({
          sql: 'INSERT INTO hints (puzzle_id, title, hint_text, sort_order, point_cost) VALUES (?, ?, ?, ?, ?)',
          args: [puzzleId, hintTitle, hintText.trim(), i, cost]
        });
      }
    }
  }

  res.redirect('/dashboard');
});

// 显示编辑谜题页面（staff）
app.get('/puzzles/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const puzzleId = parseInt(req.params.id, 10);
  const puzzleResult = await db.execute({
    sql: 'SELECT * FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  const puzzle = puzzleResult.rows[0];
  if (!puzzle) {
    return res.status(404).send('谜题不存在');
  }

  const interResult = await db.execute({
    sql: 'SELECT * FROM intermediate_answers WHERE puzzle_id = ? ORDER BY sort_order, id',
    args: [puzzleId]
  });
  const hintsResult = await db.execute({
    sql: 'SELECT * FROM hints WHERE puzzle_id = ? ORDER BY sort_order, id',
    args: [puzzleId]
  });

  res.render('puzzle_form', {
    puzzle,
    intermediateAnswers: interResult.rows,
    hints: hintsResult.rows,
    isEdit: true,
    username: req.session.username,
    isStaff: true
  });
});

// 处理编辑谜题（staff）
app.post('/puzzles/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const puzzleId = parseInt(req.params.id, 10);
  const puzzleResult = await db.execute({
    sql: 'SELECT id FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  if (puzzleResult.rows.length === 0) {
    return res.status(404).send('谜题不存在');
  }

  const {
    name = '',
    tags = '',
    description = '',
    answer,
    flavor_text = '',
    is_visible,
    inter_answers = [],
    inter_infos = [],
    hint_titles = [],
    hint_texts = [],
    point_cost = []
  } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).send('题目名称不能为空');
  }
  if (!answer || answer.trim() === '') {
    return res.status(400).send('答案不能为空');
  }

  const visibility = is_visible === 'on' ? 1 : 0;

  await db.execute({
    sql: 'UPDATE puzzles SET name = ?, tags = ?, description = ?, answer = ?, flavor_text = ?, is_visible = ? WHERE id = ?',
    args: [name.trim(), tags.trim(), description.trim(), answer.trim(), flavor_text.trim(), visibility, puzzleId]
  });

  // 删除旧的中间答案和提示
  await db.execute({
    sql: 'DELETE FROM intermediate_answers WHERE puzzle_id = ?',
    args: [puzzleId]
  });
  await db.execute({
    sql: 'DELETE FROM hints WHERE puzzle_id = ?',
    args: [puzzleId]
  });

  // 重新插入中间答案
  if (Array.isArray(inter_answers) && inter_answers.length > 0) {
    for (let i = 0; i < inter_answers.length; i++) {
      const ans = inter_answers[i];
      if (ans && ans.trim() !== '') {
        const info = inter_infos[i] || '';
        await db.execute({
          sql: 'INSERT INTO intermediate_answers (puzzle_id, answer, info, sort_order) VALUES (?, ?, ?, ?)',
          args: [puzzleId, ans.trim(), info.trim(), i]
        });
      }
    }
  }

  // 重新插入提示
  if (Array.isArray(hint_texts) && hint_texts.length > 0) {
    for (let i = 0; i < hint_texts.length; i++) {
      const hintText = hint_texts[i];
      if (hintText && hintText.trim() !== '') {
        const hintTitle = (hint_titles[i] || '').trim();
        const cost = parseInt(point_cost[i], 10) || 0;
        await db.execute({
          sql: 'INSERT INTO hints (puzzle_id, title, hint_text, sort_order, point_cost) VALUES (?, ?, ?, ?, ?)',
          args: [puzzleId, hintTitle, hintText.trim(), i, cost]
        });
      }
    }
  }

  res.redirect('/dashboard');
});

// 切换题目可见性（staff）
app.post('/puzzles/:id/toggle-visibility', requireAuth, requireStaff, async (req, res) => {
  const puzzleId = parseInt(req.params.id, 10);
  const puzzleResult = await db.execute({
    sql: 'SELECT is_visible FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  if (puzzleResult.rows.length === 0) {
    return res.status(404).send('谜题不存在');
  }
  const current = puzzleResult.rows[0].is_visible;
  const newVisibility = current ? 0 : 1;
  await db.execute({
    sql: 'UPDATE puzzles SET is_visible = ? WHERE id = ?',
    args: [newVisibility, puzzleId]
  });
  res.redirect('/dashboard');
});

// 删除谜题（staff）
app.post('/puzzles/:id/delete', requireAuth, requireStaff, async (req, res) => {
  const puzzleId = parseInt(req.params.id, 10);
  await db.execute({
    sql: 'DELETE FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  res.redirect('/dashboard');
});

// 获取单个谜题详情（辅助函数）
async function getPuzzleWithDetails(puzzleId) {
  const puzzleResult = await db.execute({
    sql: 'SELECT * FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  const puzzle = puzzleResult.rows[0];
  if (!puzzle) return null;

  const interResult = await db.execute({
    sql: 'SELECT * FROM intermediate_answers WHERE puzzle_id = ? ORDER BY sort_order, id',
    args: [puzzleId]
  });
  const hintsResult = await db.execute({
    sql: 'SELECT * FROM hints WHERE puzzle_id = ? ORDER BY sort_order, id',
    args: [puzzleId]
  });

  return {
    puzzle,
    intermediateAnswers: interResult.rows,
    hints: hintsResult.rows
  };
}

// 检查用户是否可以查看指定谜题（基于可见性、比赛报名和解锁条件）
async function canUserViewPuzzle(userId, puzzleId, isStaff, competitionId = null) {
  if (isStaff) return true;

  const puzzleResult = await db.execute({
    sql: 'SELECT is_visible FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  if (puzzleResult.rows.length === 0) return false;
  const puzzle = puzzleResult.rows[0];

  // 如果公开可见，直接允许
  if (puzzle.is_visible === 1) return true;

  // 否则需要检查比赛
  const now = new Date().toISOString();
  let competitionIds = [];
  if (competitionId) {
    const compResult = await db.execute({
      sql: `SELECT c.id
            FROM competitions c
            JOIN registrations r ON r.competition_id = c.id AND r.user_id = ?
            WHERE c.id = ?
              AND c.start_time <= ?
              AND c.end_time >= ?`,
      args: [userId, competitionId, now, now]
    });
    if (compResult.rows.length > 0) {
      competitionIds = [competitionId];
    }
  } else {
    const compResult = await db.execute({
      sql: `SELECT DISTINCT c.id
            FROM competitions c
            JOIN registrations r ON r.competition_id = c.id AND r.user_id = ?
            WHERE c.start_time <= ?
              AND c.end_time >= ?`,
      args: [userId, now, now]
    });
    competitionIds = compResult.rows.map(r => r.id);
  }

  for (const compId of competitionIds) {
    const cpResult = await db.execute({
      sql: `SELECT * FROM competition_puzzles
            WHERE competition_id = ? AND puzzle_id = ?`,
      args: [compId, puzzleId]
    });
    if (cpResult.rows.length === 0) continue;
    const cp = cpResult.rows[0];

    // 检查解锁条件
    if (cp.unlock_puzzle_ids && cp.unlock_puzzle_ids.trim() !== '') {
      const prereqIds = cp.unlock_puzzle_ids.split(',').map(s => parseInt(s.trim(), 10)).filter(id => !isNaN(id));
      const required = cp.unlock_required_count || 0;
      if (prereqIds.length === 0 || required <= 0) {
        return true;
      }
      // 查询用户在当前比赛中已解答的前置题目数量
      const solvedResult = await db.execute({
        sql: `SELECT COUNT(*) AS cnt FROM competition_answers
              WHERE competition_id = ? AND user_id = ? AND puzzle_id IN (${prereqIds.join(',')})`,
        args: [compId, userId]
      });
      const solvedCount = solvedResult.rows[0].cnt;
      if (solvedCount >= required) {
        return true;
      }
    } else {
      // 无前置条件，比赛进行中即可访问
      return true;
    }
  }

  return false;
}

async function ensureAttemptRow(competitionId, userId, puzzleId) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO competition_attempts
          (competition_id, user_id, puzzle_id, attempts_used, extra_attempts)
          VALUES (?, ?, ?, 0, 0)`,
    args: [competitionId, userId, puzzleId]
  });
}

async function getAttemptInfo(competitionId, userId, puzzleId) {
  const res = await db.execute({
    sql: 'SELECT * FROM competition_attempts WHERE competition_id = ? AND user_id = ? AND puzzle_id = ?',
    args: [competitionId, userId, puzzleId]
  });
  return res.rows[0] || { attempts_used: 0, extra_attempts: 0 };
}

// 返回剩余次数；maxAttempts<=0 表示无限制
function calcRemainingAttempts(maxAttempts, attemptsUsed, extraAttempts) {
  if (!maxAttempts || maxAttempts <= 0) return Infinity;
  return Math.max(0, maxAttempts + (extraAttempts || 0) - (attemptsUsed || 0));
}

// ================= 站内信相关辅助 =================

// 解析数据库中的时间：
//   - 本应用写入的字段（asker_can_reply_at / visible_at / last_reply_at）都是 ISO 字符串，可直接解析
//   - SQLite 的 CURRENT_TIMESTAMP 形如 "2026-11-07 09:00:00"（UTC 但无时区标识），
//     直接 new Date() 会被当作本地时间，这里补上 Z 按 UTC 解析
function parseDbTime(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return new Date(str.replace(' ', 'T') + 'Z').getTime();
  }
  const t = new Date(str).getTime();
  return isNaN(t) ? 0 : t;
}

function getInboxLockHours(competition) {
  const hours = parseFloat(competition && competition.inbox_reply_lock_hours);
  if (!isFinite(hours) || hours < 0) return 3;
  return hours;
}

function getInboxUnlockTime(competition) {
  return new Date(Date.now() + getInboxLockHours(competition) * 3600 * 1000).toISOString();
}

// 该场比赛对某用户是否正在进行中（且已报名）
async function isUserInActiveCompetition(competitionId, userId) {
  if (!competitionId || isNaN(competitionId)) return null;
  const now = new Date().toISOString();
  const compResult = await db.execute({
    sql: `SELECT c.*
          FROM competitions c
          JOIN registrations r ON r.competition_id = c.id AND r.user_id = ?
          WHERE c.id = ? AND c.start_time <= ? AND c.end_time >= ?`,
    args: [userId, competitionId, now, now]
  });
  return compResult.rows[0] || null;
}

// 组装参赛者在题目页看到的站内信信息
async function buildInboxInfo(competitionId, puzzleId, userId) {
  const competition = await isUserInActiveCompetition(competitionId, userId);
  if (!competition) return { enabled: false, state: 'not_active' };

  const canView = await canUserViewPuzzle(userId, puzzleId, false, competitionId);
  if (!canView) return { enabled: false, state: 'not_active' };

  const thread = await getInboxThread(competitionId, puzzleId, userId);
  const cost = await getInboxCost(competitionId, puzzleId);
  const state = getThreadAskState(thread);
  let messages = [];

  if (thread) {
    const msgResult = await db.execute({
      sql: `SELECT m.*, u.username
            FROM inbox_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE m.thread_id = ?
            ORDER BY m.id`,
      args: [thread.id]
    });
    const now = Date.now();
    messages = msgResult.rows
      .filter(m => {
        if (m.sender_role === 'user') return true;
        // 管理员回复：解锁时间未到就不下发，前端无法提前看到
        const visibleAt = parseDbTime(m.visible_at);
        return now >= visibleAt;
      })
      .map(m => ({
        id: Number(m.id),
        sender_role: m.sender_role,
        username: m.username,
        content: m.content,
        created_at: m.created_at
      }));
  }

  return {
    enabled: true,
    state,
    cost,
    lockHours: getInboxLockHours(competition),
    unlockAt: thread ? thread.asker_can_reply_at : null,
    messages
  };
}

// 解析某场比赛某道题的单次站内信费用；留空/负数表示本题不开放站内信
function parseInboxCost(raw) {
  if (raw === undefined || raw === null) return 0;
  const str = String(raw).trim();
  if (str === '') return 0;
  const n = parseInt(str, 10);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

async function getInboxCost(competitionId, puzzleId) {
  const cpResult = await db.execute({
    sql: 'SELECT inbox_cost FROM competition_puzzles WHERE competition_id = ? AND puzzle_id = ?',
    args: [competitionId, puzzleId]
  });
  if (cpResult.rows.length === 0) return 0;
  return parseInboxCost(cpResult.rows[0].inbox_cost);
}

async function getInboxThread(competitionId, puzzleId, userId) {
  const threadResult = await db.execute({
    sql: 'SELECT * FROM inbox_threads WHERE competition_id = ? AND puzzle_id = ? AND user_id = ?',
    args: [competitionId, puzzleId, userId]
  });
  return threadResult.rows[0] || null;
}

// 该站内信当前对参赛者而言的状态：
//   request_available  可发起询问
//   pending            已发出，待管理员处理
//   claimed            已被管理员查看处理中
//   replied_locked     已回复，待解锁（此时不可追问）
//   visible            回复已解锁，可继续追问
//   staff_view         管理员视角
function getThreadAskState(thread) {
  if (!thread) return 'request_available';
  if (thread.status === 'answered') {
    const unlockAt = parseDbTime(thread.asker_can_reply_at);
    return Date.now() < unlockAt ? 'replied_locked' : 'visible';
  }
  return thread.status === 'claimed' ? 'claimed' : 'pending';
}

// 谜题详情页
app.get('/puzzles/:id', requireAuth, async (req, res) => {
  const puzzleId = parseInt(req.params.id, 10);
  const data = await getPuzzleWithDetails(puzzleId);
  if (!data) {
    return res.status(404).send('谜题不存在');
  }
  const { puzzle, intermediateAnswers, hints } = data;

  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;
  const competitionId = req.query.competition_id ? parseInt(req.query.competition_id, 10) : null;

  const canView = await canUserViewPuzzle(req.session.userId, puzzleId, isStaff, competitionId);
  if (!canView) {
    return res.status(404).send('谜题不存在或已隐藏');
  }

  // 计算提示点（若从比赛进入且用户已报名）
  let hintPoints = null;
  let hintUnlocks = [];
  let hint_error = req.query.hint_error === '1';

  if (competitionId && !isStaff) {
    const userId = req.session.userId;
    const compResult = await db.execute({
      sql: 'SELECT * FROM competitions WHERE id = ?',
      args: [competitionId]
    });
    const competition = compResult.rows[0];
    if (competition) {
      const regResult = await db.execute({
        sql: 'SELECT registered_at FROM registrations WHERE competition_id = ? AND user_id = ?',
        args: [competitionId, userId]
      });
      if (regResult.rows.length > 0) {
        hintPoints = await getUserAvailableHintPoints(competitionId, userId);
      }
    }

    // 获取已解锁的提示ID
    const unlockRes = await db.execute({
      sql: 'SELECT hint_id FROM user_hint_unlocks WHERE competition_id = ? AND user_id = ? AND puzzle_id = ?',
      args: [competitionId, userId, puzzleId]
    });
    hintUnlocks = unlockRes.rows.map(r => parseInt(r.hint_id, 10));
  }

  const descriptionHtml = renderMarkdownImages(puzzle.description);
  const flavorTextHtml = renderMarkdownImages(puzzle.flavor_text);
    // 在得到 hints 后
  let hintMultiplier = 1;
  if (competitionId && !isStaff) {
    const multResult = await db.execute({
      sql: 'SELECT hint_point_multiplier FROM competition_puzzles WHERE competition_id = ? AND puzzle_id = ?',
      args: [competitionId, puzzleId]
    });
    if (multResult.rows.length > 0) {
      hintMultiplier = multResult.rows[0].hint_point_multiplier || 1;
    }
  }

  const hintsWithHtml = hints.map(hint => {
    const effectiveCost = Math.ceil((hint.point_cost || 0) * hintMultiplier);
    return {
      ...hint,
      effective_cost: effectiveCost,
      hint_text_html: renderMarkdownImages(hint.hint_text.trim())
    };
  });

  const result = req.query.result === 'correct' ? 'correct' :
                 req.query.result === 'incorrect' ? 'incorrect' :
                 req.query.result === 'intermediate' ? 'intermediate' : null;
  const intermediateInfo = req.query.intermediate_info || '';

  let attemptInfo = null;
  if (competitionId && !isStaff) {
    const cpResult = await db.execute({
      sql: 'SELECT max_attempts, attempt_refill_cost FROM competition_puzzles WHERE competition_id = ? AND puzzle_id = ?',
      args: [competitionId, puzzleId]
    });
    if (cpResult.rows.length > 0) {
      const cp = cpResult.rows[0];
      const maxAttempts = cp.max_attempts || 0;
      if (maxAttempts > 0) {
        const info = await getAttemptInfo(competitionId, req.session.userId, puzzleId);
        const used = info.attempts_used || 0;
        const extra = info.extra_attempts || 0;
        attemptInfo = {
          max_attempts: maxAttempts,
          extra_attempts: extra,
          attempts_used: used,
          remaining: Math.max(0, maxAttempts + extra - used),
          refill_cost: cp.attempt_refill_cost || 0
        };
      }
    }
  }

  // 站内信：仅比赛进行中、已报名、有权访问本题的参赛者
  let inboxInfo = { enabled: false, state: 'disabled' };
  if (competitionId && !isStaff) {
    inboxInfo = await buildInboxInfo(competitionId, puzzleId, req.session.userId);
  } else if (isStaff && competitionId) {
    inboxInfo = { enabled: false, state: 'staff' };
  }

  res.render('puzzle', {
    puzzle,
    descriptionHtml,
    flavorTextHtml,
    intermediateAnswers,
    hints: hintsWithHtml,
    result,
    intermediateInfo,
    username: req.session.username,
    isRoot,
    isAdmin,
    isStaff,
    canViewPuzzle: true,
    competitionId,
    hintPoints,
    hintUnlocks,
    hint_error,
    attemptInfo,
    inboxInfo,
    inboxError: req.query.inbox_error === '1'
  });
});

// 提交答案
// 提交答案
app.post('/puzzles/:id/answer', requireAuth, async (req, res) => {
  const puzzleId = parseInt(req.params.id, 10);
  const data = await getPuzzleWithDetails(puzzleId);
  if (!data) {
    return res.status(404).send('谜题不存在');
  }
  const { puzzle } = data;

  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;
  const competitionId = req.body.competition_id ? parseInt(req.body.competition_id, 10) : null;

  const canView = await canUserViewPuzzle(req.session.userId, puzzleId, isStaff, competitionId);
  if (!canView) {
    return res.status(404).send('谜题不存在或已隐藏');
  }

  // 归一化：忽略大小写和所有空白字符
  const submittedAnswer = req.body.answer ? req.body.answer.replace(/\s+/g, '').toLowerCase() : '';
  const finalAnswer = puzzle.answer.replace(/\s+/g, '').toLowerCase();

  // ① 命中正确答案：不消耗次数
  if (submittedAnswer === finalAnswer) {
    if (competitionId) {
      const userId = req.session.userId;
      const regResult = await db.execute({
        sql: 'SELECT * FROM registrations WHERE competition_id = ? AND user_id = ?',
        args: [competitionId, userId]
      });
      if (regResult.rows.length > 0) {
        await db.execute({
          sql: `INSERT INTO competition_answers (competition_id, user_id, puzzle_id)
                VALUES (?, ?, ?)
                ON CONFLICT(competition_id, user_id, puzzle_id) DO NOTHING`,
          args: [competitionId, userId, puzzleId]
        });
      }
    }
    return res.redirect(`/puzzles/${puzzleId}?result=correct&competition_id=${competitionId || ''}`);
  }

  // ② 命中中间答案：不消耗次数
  const interResult = await db.execute({
    sql: 'SELECT * FROM intermediate_answers WHERE puzzle_id = ?',
    args: [puzzleId]
  });
  for (const inter of interResult.rows) {
    const interAnswer = inter.answer.replace(/\s+/g, '').toLowerCase();
    if (submittedAnswer === interAnswer) {
      const info = inter.info || '';
      const infoParam = encodeURIComponent(info);
      return res.redirect(`/puzzles/${puzzleId}?result=intermediate&intermediate_info=${infoParam}&competition_id=${competitionId || ''}`);
    }
  }

  // ③ 走到这里说明是错误答案：此时才检查并消耗提交次数
  if (competitionId && !isStaff) {
    const cpResult = await db.execute({
      sql: 'SELECT max_attempts FROM competition_puzzles WHERE competition_id = ? AND puzzle_id = ?',
      args: [competitionId, puzzleId]
    });
    const maxAttempts = cpResult.rows.length > 0 ? (cpResult.rows[0].max_attempts || 0) : 0;

    if (maxAttempts > 0) {
      const userId = req.session.userId;

      // 确保存在统计行
      await db.execute({
        sql: `INSERT OR IGNORE INTO competition_attempts
              (competition_id, user_id, puzzle_id, attempts_used, extra_attempts)
              VALUES (?, ?, ?, 0, 0)`,
        args: [competitionId, userId, puzzleId]
      });

      const infoResult = await db.execute({
        sql: 'SELECT attempts_used, extra_attempts FROM competition_attempts WHERE competition_id = ? AND user_id = ? AND puzzle_id = ?',
        args: [competitionId, userId, puzzleId]
      });
      const info = infoResult.rows[0] || { attempts_used: 0, extra_attempts: 0 };
      const remaining = Math.max(
        0,
        maxAttempts + (info.extra_attempts || 0) - (info.attempts_used || 0)
      );

      if (remaining <= 0) {
        return res.redirect(`/puzzles/${puzzleId}?result=no_attempts&competition_id=${competitionId}`);
      }

      await db.execute({
        sql: `UPDATE competition_attempts
              SET attempts_used = attempts_used + 1
              WHERE competition_id = ? AND user_id = ? AND puzzle_id = ?`,
        args: [competitionId, userId, puzzleId]
      });
    }
  }

  return res.redirect(`/puzzles/${puzzleId}?result=incorrect&competition_id=${competitionId || ''}`);
});

// 购买提交次数
app.post('/puzzles/:id/attempts/buy', requireAuth, async (req, res) => {
  try {
    const puzzleId = parseInt(req.params.id, 10);
    const competitionId = req.body.competition_id ? parseInt(req.body.competition_id, 10) : null;
    if (!competitionId || isNaN(competitionId) || isNaN(puzzleId)) {
      return res.status(400).send('参数错误');
    }

    const userId = req.session.userId;
    const isStaff = (req.session.role === 'root' || req.session.role === 'admin');

    const cpResult = await db.execute({
      sql: 'SELECT max_attempts, attempt_refill_cost FROM competition_puzzles WHERE competition_id = ? AND puzzle_id = ?',
      args: [competitionId, puzzleId]
    });
    if (cpResult.rows.length === 0) return res.status(404).send('比赛题目规则不存在');
    const cp = cpResult.rows[0];

    const maxAttempts = cp.max_attempts || 0;
    const cost = cp.attempt_refill_cost || 0;
    if (maxAttempts <= 0) {
      return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}`);
    }

    // 剩余次数不为 0 时不允许购买
    await ensureAttemptRow(competitionId, userId, puzzleId);
    const info = await getAttemptInfo(competitionId, userId, puzzleId);
    const remaining = calcRemainingAttempts(maxAttempts, info.attempts_used, info.extra_attempts);
    if (remaining > 0) {
      return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}`);
    }

    if (!isStaff) {
      const available = await getUserAvailableHintPoints(competitionId, userId);
      if (available === null || available < cost) {
        return res.redirect(
          `/puzzles/${puzzleId}?competition_id=${competitionId}&hint_error=1`
        );
      }
    }

    await db.execute({
      sql: `UPDATE competition_attempts
            SET extra_attempts = extra_attempts + ?
            WHERE competition_id = ? AND user_id = ? AND puzzle_id = ?`,
      args: [maxAttempts, competitionId, userId, puzzleId]
    });

    if (!isStaff && cost > 0) {
      await db.execute({
        sql: `INSERT INTO user_attempt_purchases (competition_id, user_id, puzzle_id, cost)
              VALUES (?, ?, ?, ?)`,
        args: [competitionId, userId, puzzleId, cost]
      });
    }

    return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}`);
  } catch (err) {
    console.error('购买提交次数失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// ================= 比赛相关路由 =================

// 比赛列表
app.get('/competitions', requireAuth, async (req, res) => {
  const competitionsResult = await db.execute(`
    SELECT c.*,
           (SELECT COUNT(*) FROM registrations r WHERE r.competition_id = c.id) AS reg_count,
           (SELECT COUNT(*) FROM competition_puzzles cp WHERE cp.competition_id = c.id) AS puzzle_count
    FROM competitions c
    ORDER BY c.start_time ASC
  `);
  const competitions = competitionsResult.rows;
  res.render('competitions', {
    username: req.session.username,
    isStaff: (req.session.role === 'root' || req.session.role === 'admin'),
    competitions
  });
});

// 显示创建比赛表单（staff）
app.get('/competitions/new', requireAuth, requireStaff, (req, res) => {
  res.render('competition_form', {
    competition: null,
    rules: [],
    isEdit: false,
    username: req.session.username,
    isStaff: true
  });
});

// 处理创建比赛（staff）
app.post('/competitions', requireAuth, requireStaff, async (req, res) => {
  const { name, start_time, end_time, hint_points_per_minute, inbox_reply_lock_hours } = req.body;
  if (!name || !name.trim()) return res.status(400).send('比赛名称不能为空');
  if (!start_time || !end_time) return res.status(400).send('请设置开始和结束时间');
  if (new Date(start_time) >= new Date(end_time)) return res.status(400).send('结束时间必须晚于开始时间');

  const startISO = new Date(start_time).toISOString();
  const endISO = new Date(end_time).toISOString();
  const hintRate = parseFloat(hint_points_per_minute) || 0;
  const inboxLockHours = parseFloat(inbox_reply_lock_hours);
  const lockHours = isFinite(inboxLockHours) && inboxLockHours >= 0 ? inboxLockHours : 3;

  const insertResult = await db.execute({
    sql: 'INSERT INTO competitions (name, start_time, end_time, hint_points_per_minute, inbox_reply_lock_hours) VALUES (?, ?, ?, ?, ?)',
    args: [name.trim(), startISO, endISO, hintRate, lockHours]
  });
  const compId = insertResult.lastInsertRowid;

  const puzzleIds = req.body.puzzle_ids || [];
  const unlockIds = req.body.unlock_ids || [];
  const unlockCounts = req.body.unlock_counts || [];
  const isMeta = req.body.is_meta || [];
  const hintMultipliers = req.body.hint_point_multipliers || [];
  const maxAttemptsArr = req.body.max_attempts || [];
  const refillCostArr = req.body.attempt_refill_cost || [];
  const inboxCosts = req.body.inbox_costs || [];

  for (let i = 0; i < puzzleIds.length; i++) {
    const pid = parseInt(puzzleIds[i], 10);
    if (!isNaN(pid)) {
      const unlock = unlockIds[i] ? unlockIds[i].trim() : '';
      const count = parseInt(unlockCounts[i], 10) || 0;
      const meta = parseInt(isMeta[i], 10) || 0;
      const multiplier = parseFloat(hintMultipliers[i]) || 1.0;
      const maxAttempts = parseInt(maxAttemptsArr[i], 10) || 0;
      const refillCost = parseInt(refillCostArr[i], 10) || 0;
      const inboxCost = parseInboxCost(inboxCosts[i]);

      await db.execute({
        sql: `INSERT OR IGNORE INTO competition_puzzles
              (competition_id, puzzle_id, sort_order, unlock_puzzle_ids, unlock_required_count, is_meta, hint_point_multiplier, max_attempts, attempt_refill_cost, inbox_cost)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [compId, pid, i, unlock, count, meta, multiplier, maxAttempts, refillCost, inboxCost]
      });
    }
  }

  res.redirect('/competitions');
});

// 显示编辑比赛表单（staff）
app.get('/competitions/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  const competition = compResult.rows[0];
  if (!competition) return res.status(404).send('比赛不存在');

  const rulesResult = await db.execute({
    sql: 'SELECT * FROM competition_puzzles WHERE competition_id = ? ORDER BY sort_order, puzzle_id',
    args: [compId]
  });
  const rules = rulesResult.rows;

  res.render('competition_form', {
    competition,
    rules,
    isEdit: true,
    username: req.session.username,
    isStaff: true
  });
});

// 处理编辑比赛（staff）
app.post('/competitions/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  const { name, start_time, end_time, hint_points_per_minute, inbox_reply_lock_hours } = req.body;
  if (!name || !name.trim()) return res.status(400).send('比赛名称不能为空');
  if (!start_time || !end_time) return res.status(400).send('请设置开始和结束时间');
  if (new Date(start_time) >= new Date(end_time)) return res.status(400).send('结束时间必须晚于开始时间');

  const startISO = new Date(start_time).toISOString();
  const endISO = new Date(end_time).toISOString();
  const hintRate = parseFloat(hint_points_per_minute) || 0;
  const inboxLockHours = parseFloat(inbox_reply_lock_hours);
  const lockHours = isFinite(inboxLockHours) && inboxLockHours >= 0 ? inboxLockHours : 3;

  await db.execute({
    sql: 'UPDATE competitions SET name = ?, start_time = ?, end_time = ?, hint_points_per_minute = ?, inbox_reply_lock_hours = ? WHERE id = ?',
    args: [name.trim(), startISO, endISO, hintRate, lockHours, compId]
  });

  await db.execute({
    sql: 'DELETE FROM competition_puzzles WHERE competition_id = ?',
    args: [compId]
  });

  const puzzleIds = req.body.puzzle_ids || [];
  const unlockIds = req.body.unlock_ids || [];
  const unlockCounts = req.body.unlock_counts || [];
  const isMeta = req.body.is_meta || [];
  const hintMultipliers = req.body.hint_point_multipliers || [];
  const maxAttemptsArr = req.body.max_attempts || [];
  const refillCostArr = req.body.attempt_refill_cost || [];
  const inboxCosts = req.body.inbox_costs || [];

  // 删除旧数据后插入新数据
  for (let i = 0; i < puzzleIds.length; i++) {
    const pid = parseInt(puzzleIds[i], 10);
    if (!isNaN(pid)) {
      const unlock = unlockIds[i] ? unlockIds[i].trim() : '';
      const count = parseInt(unlockCounts[i], 10) || 0;
      const meta = parseInt(isMeta[i], 10) || 0;
      const multiplier = parseFloat(hintMultipliers[i]) || 1.0;
      const maxAttempts = parseInt(maxAttemptsArr[i], 10) || 0;
      const refillCost = parseInt(refillCostArr[i], 10) || 0;
      const inboxCost = parseInboxCost(inboxCosts[i]);
      await db.execute({
        sql: `INSERT OR IGNORE INTO competition_puzzles
              (competition_id, puzzle_id, sort_order, unlock_puzzle_ids, unlock_required_count, is_meta, hint_point_multiplier, max_attempts, attempt_refill_cost, inbox_cost)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [compId, pid, i, unlock, count, meta, multiplier, maxAttempts, refillCost, inboxCost]
      });
    }
  }

  res.redirect(`/competitions/${compId}`);
});

// 显示比赛详情
app.get('/competitions/:id', requireAuth, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  if (isNaN(compId)) return res.status(400).send('无效的比赛ID');

  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  const competition = compResult.rows[0];
  if (!competition) return res.status(404).send('比赛不存在');

  const userId = req.session.userId;
  const isStaff = (req.session.role === 'root' || req.session.role === 'admin');

  const regResult = await db.execute({
    sql: 'SELECT registered_at FROM registrations WHERE competition_id = ? AND user_id = ?',
    args: [compId, userId]
  });
  const isRegistered = regResult.rows.length > 0;
  const registeredAt = isRegistered ? regResult.rows[0].registered_at : null;

  // 计算提示点
  let hintPoints = null;
  if (isRegistered && !isStaff) {
    hintPoints = await getUserAvailableHintPoints(compId, userId);
  }

  const cpResult = await db.execute({
    sql: `SELECT cp.puzzle_id, cp.unlock_puzzle_ids, cp.unlock_required_count,
                 cp.is_meta,
                 p.name, p.tags, p.is_visible, p.answer,
                 (SELECT COUNT(*) FROM competition_answers ca
                  WHERE ca.competition_id = cp.competition_id AND ca.user_id = ? AND ca.puzzle_id = cp.puzzle_id) AS solved
          FROM competition_puzzles cp
          JOIN puzzles p ON p.id = cp.puzzle_id
          WHERE cp.competition_id = ?
          ORDER BY cp.sort_order, cp.puzzle_id`,
    args: [userId, compId]
  });
  const rules = cpResult.rows;

  const now = new Date();
  const startTime = new Date(competition.start_time);
  const endTime = new Date(competition.end_time);
  const isActive = now >= startTime && now <= endTime;

  const puzzlesToDisplay = rules.map(rule => {
    const solved = rule.solved > 0;
    let canView = false;
    if (isStaff) canView = true;
    else if (isRegistered && isActive) {
      if (!rule.unlock_puzzle_ids || rule.unlock_puzzle_ids.trim() === '') {
        canView = true;
      } else {
        const prereqIds = rule.unlock_puzzle_ids.split(',').map(s => parseInt(s.trim(), 10)).filter(id => !isNaN(id));
        const required = rule.unlock_required_count || 0;
        if (prereqIds.length === 0 || required <= 0) {
          canView = true;
        } else {
          const solvedCount = rules.filter(r => prereqIds.includes(r.puzzle_id) && r.solved > 0).length;
          canView = solvedCount >= required;
        }
      }
    }
    return {
      id: rule.puzzle_id,
      name: rule.name,
      tags: rule.tags,
      is_visible: rule.is_visible,
      answer: rule.answer,
      is_meta: rule.is_meta,
      solved,
      canView
    };
  });

  let inboxPendingCount = 0;
  let inboxClaimedCount = 0;
  if (isStaff) {
    const inboxStatResult = await db.execute({
      sql: `SELECT
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
              SUM(CASE WHEN status = 'claimed' AND claimed_by = ? THEN 1 ELSE 0 END) AS my_count
            FROM inbox_threads
            WHERE competition_id = ?`,
      args: [userId, compId]
    });
    inboxPendingCount = Number(inboxStatResult.rows[0].pending_count || 0);
    inboxClaimedCount = Number(inboxStatResult.rows[0].my_count || 0);
  }

  res.render('competition_detail', {
    competition,
    puzzles: puzzlesToDisplay,
    isRegistered,
    isActive,
    isStaff,
    username: req.session.username,
    hintPoints,
    hintRate: competition.hint_points_per_minute || 0,
    inboxPendingCount,
    inboxClaimedCount
  });
});

// 报名比赛
app.post('/competitions/:id/register', requireAuth, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  const userId = req.session.userId;
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  if (compResult.rows.length === 0) return res.status(404).send('比赛不存在');

  const regResult = await db.execute({
    sql: 'SELECT * FROM registrations WHERE competition_id = ? AND user_id = ?',
    args: [compId, userId]
  });
  if (regResult.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO registrations (competition_id, user_id) VALUES (?, ?)',
      args: [compId, userId]
    });
  }
  res.redirect(`/competitions/${compId}`);
});

// 获取当前用户在指定比赛的提示点
app.get('/api/competitions/:id/hint-points', requireAuth, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  if (isNaN(compId)) return res.status(400).json({ error: '无效的比赛ID' });
  const userId = req.session.userId;
  const isStaff = (req.session.role === 'root' || req.session.role === 'admin');

  // 检查比赛是否存在
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  if (compResult.rows.length === 0) return res.status(404).json({ error: '比赛不存在' });

  // 如果用户是 staff，返回 null 或 0？我们让前端隐藏提示点即可
  if (isStaff) return res.json({ hintPoints: null });

  // 检查是否已报名
  const regResult = await db.execute({
    sql: 'SELECT registered_at FROM registrations WHERE competition_id = ? AND user_id = ?',
    args: [compId, userId]
  });
  if (regResult.rows.length === 0) return res.json({ hintPoints: null });

  const availablePoints = await getUserAvailableHintPoints(compId, userId);
  return res.json({ hintPoints: availablePoints });
});

// 比赛排行榜
app.get('/competitions/:id/leaderboard', requireAuth, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  if (isNaN(compId)) return res.status(400).send('无效的比赛ID');

  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  const competition = compResult.rows[0];
  if (!competition) return res.status(404).send('比赛不存在');

  const leaderboardResult = await db.execute({
    sql: `SELECT u.username,
                 COUNT(ca.puzzle_id) AS total_solved,
                 SUM(CASE WHEN cp.is_meta = 1 THEN 1 ELSE 0 END) AS meta_solved,
                 MAX(CASE WHEN cp.is_meta = 1 THEN ca.solved_at END) AS last_meta_solved
          FROM competition_answers ca
          JOIN users u ON u.id = ca.user_id
          LEFT JOIN competition_puzzles cp 
               ON cp.competition_id = ca.competition_id AND cp.puzzle_id = ca.puzzle_id
          WHERE ca.competition_id = ?
          GROUP BY ca.user_id, u.username
          ORDER BY meta_solved DESC, last_meta_solved ASC, total_solved DESC`,
    args: [compId]
  });
  const leaderboard = leaderboardResult.rows;

  res.render('leaderboard', {
    competition,
    leaderboard,
    username: req.session.username,
    isStaff: (req.session.role === 'root' || req.session.role === 'admin')
  });
});

// 删除比赛（staff）
app.post('/competitions/:id/delete', requireAuth, requireStaff, async (req, res) => {
  const compId = parseInt(req.params.id, 10);
  await db.execute({
    sql: 'DELETE FROM competitions WHERE id = ?',
    args: [compId]
  });
  res.redirect('/competitions');
});

// 解锁提示
app.post('/puzzles/:id/hints/:hint_id/unlock', requireAuth, async (req, res) => {
  try {
    const puzzleId = parseInt(req.params.id, 10);
    const hintId = parseInt(req.params.hint_id, 10);
    const competitionId = req.body.competition_id ? parseInt(req.body.competition_id, 10) : null;

    if (!competitionId || isNaN(competitionId) || isNaN(puzzleId) || isNaN(hintId)) {
      return res.status(400).send('参数错误');
    }

    const userId = req.session.userId;
    const isStaff = (req.session.role === 'root' || req.session.role === 'admin');

    const data = await getPuzzleWithDetails(puzzleId);
    if (!data) return res.status(404).send('谜题不存在');
    const hint = data.hints.find(h => h.id === hintId);
    if (!hint) return res.status(404).send('提示不存在');

    const canView = await canUserViewPuzzle(userId, puzzleId, isStaff, competitionId);
    if (!canView) return res.status(403).send('无权访问该谜题');

    // 检查已解锁
    const existing = await db.execute({
      sql: 'SELECT * FROM user_hint_unlocks WHERE competition_id = ? AND user_id = ? AND puzzle_id = ? AND hint_id = ?',
      args: [competitionId, userId, puzzleId, hintId]
    });
    if (existing.rows.length > 0) {
      return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}`);
    }
    let hintMultiplier = 1;
    const multResult = await db.execute({
      sql: 'SELECT hint_point_multiplier FROM competition_puzzles WHERE competition_id = ? AND puzzle_id = ?',
      args: [competitionId, puzzleId]
    });
    if (multResult.rows.length > 0) {
      hintMultiplier = multResult.rows[0].hint_point_multiplier || 1;
    }
    const cost = Math.ceil((hint.point_cost || 0) * hintMultiplier);
    if (!isStaff) {
      const available = await getUserAvailableHintPoints(competitionId, userId);
      if (available === null) {
        return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}&hint_error=1`);
      }
      if (available < cost) {
        return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}&hint_error=1`);
      }
    }

    // 插入解锁记录
    await db.execute({
      sql: `INSERT INTO user_hint_unlocks (competition_id, user_id, puzzle_id, hint_id, cost)
            VALUES (?, ?, ?, ?, ?)`,
      args: [competitionId, userId, puzzleId, hintId, isStaff ? 0 : cost]
    });

    return res.redirect(`/puzzles/${puzzleId}?competition_id=${competitionId}`);
  } catch (err) {
    console.error('解锁提示失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 用户在题目页发起站内信询问 / 追问（仅针对本题，仅限本场比赛）
app.post('/puzzles/:id/inbox', requireAuth, async (req, res) => {
  try {
    const puzzleId = parseInt(req.params.id, 10);
    const competitionId = req.body.competition_id ? parseInt(req.body.competition_id, 10) : null;
    const backUrl = `/puzzles/${puzzleId}${competitionId ? `?competition_id=${competitionId}` : ''}`;
    const userId = req.session.userId;

    if (!competitionId || isNaN(competitionId) || isNaN(puzzleId)) {
      return res.redirect(backUrl);
    }

    const competition = await isUserInActiveCompetition(competitionId, userId);
    const canView = competition && (await canUserViewPuzzle(userId, puzzleId, false, competitionId));
    if (!canView) {
      return res.status(403).send('无权访问该题目的站内信');
    }

    const content = (req.body.content || '').trim();
    if (!content) {
      return res.redirect(`${backUrl}&inbox_error=1`);
    }
    if (content.length > 5000) {
      return res.status(400).send('站内信内容过长（最多 5000 字）');
    }

    const thread = await getInboxThread(competitionId, puzzleId, userId);
    const state = getThreadAskState(thread);

    // 回复未解锁前不允许追问；已发出但管理员未回复前也不能重复发
    if (state === 'replied_locked' || state === 'claimed' || state === 'pending') {
      return res.status(403).send('当前无法追问：请等待管理员回复解锁');
    }

    const unlockTime = getInboxUnlockTime(competition);
    const cost = await getInboxCost(competitionId, puzzleId);

    if (!thread) {
      // 新发起：需要支付本题设定的提示点
      if (cost <= 0) {
        return res.status(403).send('本题未开放站内信');
      }
      const available = await getUserAvailableHintPoints(competitionId, userId);
      if (available === null || available < cost) {
        return res.redirect(`${backUrl}&inbox_error=1`);
      }
      await db.execute({
        sql: `INSERT INTO inbox_threads
              (competition_id, puzzle_id, user_id, status, asker_can_reply_at)
              VALUES (?, ?, ?, 'pending', ?)`,
        args: [competitionId, puzzleId, userId, unlockTime]
      });
    } else {
      // 追问：重新打开会话，等待管理员再次处理（新一轮不再收费）
      await db.execute({
        sql: `UPDATE inbox_threads
              SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
                  asker_can_reply_at = ?, last_reply_at = NULL
              WHERE id = ?`,
        args: [unlockTime, thread.id]
      });
    }

    // 唯一约束保证同用户同题只有一条会话
    const threadId = thread
      ? thread.id
      : (await getInboxThread(competitionId, puzzleId, userId)).id;
    await db.execute({
      sql: `INSERT INTO inbox_messages
            (thread_id, sender_role, sender_id, content, visible_at, is_locked)
            VALUES (?, 'user', ?, ?, ?, 0)`,
      args: [threadId, userId, content, unlockTime]
    });

    if (!thread && cost > 0) {
      await db.execute({
        sql: `INSERT INTO user_inbox_purchases (competition_id, user_id, puzzle_id, cost)
              VALUES (?, ?, ?, ?)`,
        args: [competitionId, puzzleId, userId, cost]
      });
    }

    return res.redirect(backUrl);
  } catch (err) {
    console.error('发送站内信失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// ================= 站内信分配中心（staff） =================

// 分配中心列表
app.get('/competitions/:id/inbox', requireAuth, requireStaff, async (req, res) => {
  try {
    const compId = parseInt(req.params.id, 10);
    if (isNaN(compId)) return res.status(400).send('无效的比赛ID');

    const compResult = await db.execute({
      sql: 'SELECT * FROM competitions WHERE id = ?',
      args: [compId]
    });
    const competition = compResult.rows[0];
    if (!competition) return res.status(404).send('比赛不存在');

    const threadResult = await db.execute({
      sql: `SELECT t.*, u.username, p.name AS puzzle_name
            FROM inbox_threads t
            JOIN users u ON u.id = t.user_id
            JOIN puzzles p ON p.id = t.puzzle_id
            WHERE t.competition_id = ?
            ORDER BY
              CASE t.status WHEN 'pending' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
              t.created_at ASC`,
      args: [compId]
    });

    // 每个会话最后一次消息 + 消息数
    const lastMsgResult = await db.execute({
      sql: `SELECT thread_id, COUNT(*) AS msg_count,
                   MAX(id) AS last_msg_id
            FROM inbox_messages
            WHERE thread_id IN (SELECT id FROM inbox_threads WHERE competition_id = ?)
            GROUP BY thread_id`,
      args: [compId]
    });
    const lastMsgMap = {};
    lastMsgResult.rows.forEach(row => {
      lastMsgMap[String(row.thread_id)] = row;
    });

    const now = Date.now();
    const threads = threadResult.rows.map(t => {
      const unlockAt = parseDbTime(t.asker_can_reply_at);
      const revealAt = parseDbTime(t.last_reply_at);
      return {
        id: t.id,
        puzzle_id: t.puzzle_id,
        puzzle_name: t.puzzle_name,
        username: t.username,
        status: t.status,
        claimed_by: t.claimed_by,
        claimed_by_name: null, // 需要二次查询
        created_at: t.created_at,
        asker_can_reply_at: t.asker_can_reply_at,
        last_reply_at: t.last_reply_at,
        msg_count: lastMsgMap[String(t.id)] ? lastMsgMap[String(t.id)].msg_count : 0,
        replyReadable: t.status === 'answered' && revealAt > 0 && now >= revealAt
      };
    });

    // 填充认领人用户名
    const claimerIds = [...new Set(threads.filter(t => t.claimed_by).map(t => t.claimed_by))];
    if (claimerIds.length > 0) {
      const claimerResult = await db.execute({
        sql: `SELECT id, username FROM users WHERE id IN (${claimerIds.map(() => '?').join(',')})`,
        args: claimerIds.map(Number)
      });
      const nameMap = {};
      claimerResult.rows.forEach(r => { nameMap[String(r.id)] = r.username; });
      threads.forEach(t => { t.claimed_by_name = t.claimed_by ? nameMap[String(t.claimed_by)] || '未知' : null; });
    }

    const stats = {
      pending: threads.filter(t => t.status === 'pending').length,
      claimed: threads.filter(t => t.status === 'claimed').length,
      answered: threads.filter(t => t.status === 'answered').length
    };

    res.render('inbox_center', {
      competition,
      threads,
      stats,
      username: req.session.username,
      currentUserId: req.session.userId,
      repliedDone: req.query.done === '1',
      isStaff: true
    });
  } catch (err) {
    console.error('加载分配中心失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 认领一封待处理站内信（原子操作，防止多人同时查看）
app.post('/inbox/:thread_id/claim', requireAuth, requireStaff, async (req, res) => {
  try {
    const threadId = parseInt(req.params.thread_id, 10);
    if (isNaN(threadId)) return res.status(400).send('无效的站内信ID');

    const updateResult = await db.execute({
      sql: `UPDATE inbox_threads
            SET status = 'claimed', claimed_by = ?, claimed_at = ?
            WHERE id = ? AND status = 'pending'`,
      args: [req.session.userId, new Date().toISOString(), threadId]
    });

    if (updateResult.rowsAffected === 0) {
      // 认领失败：要么已被他人锁定，要么已不是待处理状态
      const cur = await db.execute({
        sql: 'SELECT * FROM inbox_threads WHERE id = ?',
        args: [threadId]
      });
      if (cur.rows.length === 0) return res.status(404).send('站内信不存在');
      // 已被自己（或同一人）锁定，可直接进入
      if (Number(cur.rows[0].claimed_by) === req.session.userId && cur.rows[0].status === 'claimed') {
        return res.redirect(`/inbox/${threadId}`);
      }
      return res.status(409).send('这封站内信已被其他管理员查看并锁定');
    }

    return res.redirect(`/inbox/${threadId}`);
  } catch (err) {
    console.error('认领站内信失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 站内信详情（只有认领者本人可查看并回复）
app.get('/inbox/:thread_id', requireAuth, requireStaff, async (req, res) => {
  try {
    const threadId = parseInt(req.params.thread_id, 10);
    if (isNaN(threadId)) return res.status(400).send('无效的站内信ID');

    const threadResult = await db.execute({
      sql: `SELECT t.*, u.username, p.name AS puzzle_name, c.name AS competition_name
            FROM inbox_threads t
            JOIN users u ON u.id = t.user_id
            JOIN puzzles p ON p.id = t.puzzle_id
            JOIN competitions c ON c.id = t.competition_id
            WHERE t.id = ?`,
      args: [threadId]
    });
    const thread = threadResult.rows[0];
    if (!thread) return res.status(404).send('站内信不存在');

    // 已回复的会话不再锁定，允许原锁定者回看自己写过的回复
    const canRead = Number(thread.claimed_by) === req.session.userId;
    if (!canRead) {
      return res.status(403).send('这封站内信已被其他管理员锁定或已处理，你无法查看。请返回分配中心查看其他事项。');
    }

    // 管理员可以在详情里看到全部消息（包括尚未解锁的回复，用于确认自己已回复）
    const msgResult = await db.execute({
      sql: `SELECT m.*, u.username
            FROM inbox_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE m.thread_id = ?
            ORDER BY m.id`,
      args: [threadId]
    });
    const now = Date.now();
    const messages = msgResult.rows.map(m => ({
      id: Number(m.id),
      sender_role: m.sender_role,
      username: m.username,
      content: m.content,
      created_at: m.created_at,
      is_locked: m.sender_role !== 'user' && (parseDbTime(m.visible_at) > now)
    }));
    res.render('inbox_thread', {
      thread,
      messages,
      username: req.session.username,
      isStaff: true
    });
  } catch (err) {
    console.error('加载站内信详情失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 管理员回复
app.post('/inbox/:thread_id/reply', requireAuth, requireStaff, async (req, res) => {
  try {
    const threadId = parseInt(req.params.thread_id, 10);
    if (isNaN(threadId)) return res.status(400).send('无效的站内信ID');

    const threadResult = await db.execute({
      sql: 'SELECT * FROM inbox_threads WHERE id = ?',
      args: [threadId]
    });
    const thread = threadResult.rows[0];
    if (!thread) return res.status(404).send('站内信不存在');
    if (thread.status !== 'claimed' || Number(thread.claimed_by) !== req.session.userId) {
      return res.status(403).send('只有当前锁定该站内信的管理员才能回复');
    }

    const content = (req.body.content || '').trim();
    if (!content) return res.status(400).send('回复内容不能为空');
    if (content.length > 5000) return res.status(400).send('回复内容过长（最多 5000 字）');

    const compResult = await db.execute({
      sql: 'SELECT * FROM competitions WHERE id = ?',
      args: [thread.competition_id]
    });
    const competition = compResult.rows[0];

    // 解锁时间以“参赛者提问的时间”为基准：提问 3h（或配置的小时数）后回复才对参赛者可见
    const askAt = thread.created_at ? parseDbTime(thread.created_at) : Date.now();
    const unlockTime = new Date(
      askAt + getInboxLockHours(competition) * 3600 * 1000
    ).toISOString();

    // 更新会话：标记已回复，并刷新参赛者的解锁时间
    await db.execute({
      sql: `UPDATE inbox_threads
            SET status = 'answered', asker_can_reply_at = ?, last_reply_at = ?
            WHERE id = ?`,
      args: [unlockTime, new Date().toISOString(), threadId]
    });

    await db.execute({
      sql: `INSERT INTO inbox_messages
            (thread_id, sender_role, sender_id, content, visible_at, is_locked)
            VALUES (?, 'staff', ?, ?, ?, 1)`,
      args: [threadId, req.session.userId, content, unlockTime]
    });

    return res.redirect('/competitions/' + thread.competition_id + '/inbox?done=1');
  } catch (err) {
    console.error('回复站内信失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 释放锁定（管理员主动放回待处理队列）
app.post('/inbox/:thread_id/release', requireAuth, requireStaff, async (req, res) => {
  try {
    const threadId = parseInt(req.params.thread_id, 10);
    if (isNaN(threadId)) return res.status(400).send('无效的站内信ID');

    const updateResult = await db.execute({
      sql: `UPDATE inbox_threads
            SET status = 'pending', claimed_by = NULL, claimed_at = NULL
            WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
      args: [threadId, req.session.userId]
    });
    if (updateResult.rowsAffected === 0) {
      return res.status(403).send('只能释放自己锁定的站内信');
    }
    const cur = await db.execute({
      sql: 'SELECT competition_id FROM inbox_threads WHERE id = ?',
      args: [threadId]
    });
    const backComp = cur.rows.length > 0 ? cur.rows[0].competition_id : null;
    return res.redirect(backComp ? `/competitions/${backComp}/inbox` : '/inbox');
  } catch (err) {
    console.error('释放站内信失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 站内信总览：跨比赛展示当前管理员锁定的与待处理的站内信
app.get('/inbox', requireAuth, requireStaff, async (req, res) => {
  try {
    const userId = req.session.userId;
    const pendingResult = await db.execute({
      sql: `SELECT t.*, u.username, p.name AS puzzle_name, c.name AS competition_name
            FROM inbox_threads t
            JOIN users u ON u.id = t.user_id
            JOIN puzzles p ON p.id = t.puzzle_id
            JOIN competitions c ON c.id = t.competition_id
            WHERE t.status = 'pending'
            ORDER BY t.created_at ASC`,
      args: []
    });
    const mineResult = await db.execute({
      sql: `SELECT t.*, u.username, p.name AS puzzle_name, c.name AS competition_name
            FROM inbox_threads t
            JOIN users u ON u.id = t.user_id
            JOIN puzzles p ON p.id = t.puzzle_id
            JOIN competitions c ON c.id = t.competition_id
            WHERE t.status = 'claimed' AND t.claimed_by = ?
            ORDER BY t.claimed_at ASC`,
      args: [userId]
    });

    res.render('inbox_overview', {
      pendingThreads: pendingResult.rows,
      myThreads: mineResult.rows,
      username: req.session.username,
      isStaff: true,
      justDone: req.query.done === '1'
    });
  } catch (err) {
    console.error('加载站内信总览失败:', err);
    return res.status(500).send('服务器内部错误');
  }
});

// 用户管理页面（staff）
app.get('/admin/users', requireAuth, requireStaff, async (req, res) => {
  const usersResult = await db.execute('SELECT id, username, email, is_approved, role FROM users ORDER BY id');
  res.render('admin_users', {
    users: usersResult.rows,
    username: req.session.username,
    currentUserRole: req.session.role
  });
});

// 批准用户（staff）
app.post('/admin/users/:id/approve', requireAuth, requireStaff, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [userId]
  });
  const user = userResult.rows[0];
  if (!user) return res.status(404).send('用户不存在');
  if (user.role === 'root') return res.redirect('/admin/users');
  await db.execute({
    sql: 'UPDATE users SET is_approved = 1 WHERE id = ?',
    args: [userId]
  });
  res.redirect('/admin/users');
});

// 删除用户（staff，但有角色限制）
app.post('/admin/users/:id/delete', requireAuth, requireStaff, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [userId]
  });
  const user = userResult.rows[0];
  if (!user) return res.status(404).send('用户不存在');
  if (req.session.role === 'root') {
    if (user.role !== 'root') {
      await db.execute({
        sql: 'DELETE FROM users WHERE id = ?',
        args: [userId]
      });
    }
  } else {
    if (user.role === 'user') {
      await db.execute({
        sql: 'DELETE FROM users WHERE id = ?',
        args: [userId]
      });
    }
  }
  res.redirect('/admin/users');
});

// 设置/取消管理员（仅 root）
app.post('/admin/users/:id/set-admin', requireAuth, requireRoot, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { action } = req.body;
  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [userId]
  });
  const user = userResult.rows[0];
  if (!user) return res.status(404).send('用户不存在');
  if (user.role === 'root') return res.redirect('/admin/users');
  if (action === 'promote') {
    await db.execute({
      sql: 'UPDATE users SET role = ? WHERE id = ?',
      args: ['admin', userId]
    });
  } else if (action === 'demote') {
    await db.execute({
      sql: 'UPDATE users SET role = ? WHERE id = ?',
      args: ['user', userId]
    });
  }
  res.redirect('/admin/users');
});

app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});