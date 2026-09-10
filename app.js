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
app.post('/register', async (req, res) => {
  const { username, email, password, confirm_password } = req.body;
  if (!username || !email || !password || !confirm_password) {
    return res.render('register', { error: '所有字段均为必填' });
  }
  if (password !== confirm_password) {
    return res.render('register', { error: '两次输入的密码不一致' });
  }
  if (password.length < 8) {
    return res.render('register', { error: '密码长度至少为8位' });
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
    hint_texts = []
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

  if (Array.isArray(hint_texts) && hint_texts.length > 0) {
    for (let i = 0; i < hint_texts.length; i++) {
      const hintText = hint_texts[i];
      if (hintText && hintText.trim() !== '') {
        const hintTitle = (hint_titles[i] || '').trim();
        await db.execute({
          sql: 'INSERT INTO hints (puzzle_id, title, hint_text, sort_order) VALUES (?, ?, ?, ?)',
          args: [puzzleId, hintTitle, hintText.trim(), i]
        });
      }
    }
  }

  res.redirect('/dashboard');
});

// 显示编辑谜题页面（staff）
app.get('/puzzles/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const puzzleId = req.params.id;
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
  const puzzleId = req.params.id;
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
    hint_texts = []
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

  await db.execute({
    sql: 'DELETE FROM intermediate_answers WHERE puzzle_id = ?',
    args: [puzzleId]
  });
  await db.execute({
    sql: 'DELETE FROM hints WHERE puzzle_id = ?',
    args: [puzzleId]
  });

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

  if (Array.isArray(hint_texts) && hint_texts.length > 0) {
    for (let i = 0; i < hint_texts.length; i++) {
      const hintText = hint_texts[i];
      if (hintText && hintText.trim() !== '') {
        const hintTitle = (hint_titles[i] || '').trim();
        await db.execute({
          sql: 'INSERT INTO hints (puzzle_id, title, hint_text, sort_order) VALUES (?, ?, ?, ?)',
          args: [puzzleId, hintTitle, hintText.trim(), i]
        });
      }
    }
  }

  res.redirect('/dashboard');
});

// 切换题目可见性（staff）
app.post('/puzzles/:id/toggle-visibility', requireAuth, requireStaff, async (req, res) => {
  const puzzleId = req.params.id;
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
  await db.execute({
    sql: 'DELETE FROM puzzles WHERE id = ?',
    args: [req.params.id]
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

// 谜题详情页
app.get('/puzzles/:id', requireAuth, async (req, res) => {
  const puzzleId = req.params.id;
  const data = await getPuzzleWithDetails(puzzleId);
  if (!data) {
    return res.status(404).send('谜题不存在');
  }
  const { puzzle, intermediateAnswers, hints } = data;

  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;

  let canViewPuzzle = false;
  if (isStaff) {
    canViewPuzzle = true;
  } else if (puzzle.is_visible === 1) {
    canViewPuzzle = true;
  } else {
    // 检查用户是否报名了包含该题目的进行中的比赛
    const userId = req.session.userId;
    const now = new Date().toISOString();
    const compResult = await db.execute({
      sql: `SELECT c.id
            FROM competitions c
            JOIN competition_puzzles cp ON c.id = cp.competition_id
            JOIN registrations r ON r.competition_id = c.id AND r.user_id = ?
            WHERE cp.puzzle_id = ?
              AND c.start_time <= ?
              AND c.end_time >= ?`,
      args: [userId, puzzleId, now, now]
    });
    if (compResult.rows.length > 0) {
      canViewPuzzle = true;
    }
  }

  if (!canViewPuzzle) {
    return res.status(404).send('谜题不存在或已隐藏');
  }

  const descriptionHtml = renderMarkdownImages(puzzle.description);
  const flavorTextHtml = renderMarkdownImages(puzzle.flavor_text);
  const hintsWithHtml = hints.map(hint => ({
    ...hint,
    hint_text_html: renderMarkdownImages(hint.hint_text)
  }));

  const result = req.query.result === 'correct' ? 'correct' :
                 req.query.result === 'incorrect' ? 'incorrect' :
                 req.query.result === 'intermediate' ? 'intermediate' : null;
  const intermediateInfo = req.query.intermediate_info || '';

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
    canViewPuzzle
  });
});

// 提交答案
app.post('/puzzles/:id/answer', requireAuth, async (req, res) => {
  const puzzleId = req.params.id;
  const data = await getPuzzleWithDetails(puzzleId);
  if (!data) {
    return res.status(404).send('谜题不存在');
  }
  const { puzzle } = data;

  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;

  let canViewPuzzle = false;
  if (isStaff) {
    canViewPuzzle = true;
  } else if (puzzle.is_visible === 1) {
    canViewPuzzle = true;
  } else {
    const userId = req.session.userId;
    const now = new Date().toISOString();
    const compResult = await db.execute({
      sql: `SELECT c.id
            FROM competitions c
            JOIN competition_puzzles cp ON c.id = cp.competition_id
            JOIN registrations r ON r.competition_id = c.id AND r.user_id = ?
            WHERE cp.puzzle_id = ?
              AND c.start_time <= ?
              AND c.end_time >= ?`,
      args: [userId, puzzleId, now, now]
    });
    if (compResult.rows.length > 0) {
      canViewPuzzle = true;
    }
  }

  if (!canViewPuzzle) {
    return res.status(404).send('谜题不存在或已隐藏');
  }

  const submittedAnswer = req.body.answer ? req.body.answer.trim().toLowerCase() : '';
  const finalAnswer = puzzle.answer.trim().toLowerCase();

  if (submittedAnswer === finalAnswer) {
    return res.redirect(`/puzzles/${puzzle.id}?result=correct`);
  }

  const interResult = await db.execute({
    sql: 'SELECT * FROM intermediate_answers WHERE puzzle_id = ?',
    args: [puzzleId]
  });
  for (const inter of interResult.rows) {
    if (submittedAnswer === inter.answer.trim().toLowerCase()) {
      const info = inter.info || '';
      const infoParam = encodeURIComponent(info);
      return res.redirect(`/puzzles/${puzzle.id}?result=intermediate&intermediate_info=${infoParam}`);
    }
  }

  return res.redirect(`/puzzles/${puzzle.id}?result=incorrect`);
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
app.get('/competitions/new', requireAuth, requireStaff, async (req, res) => {
  const puzzlesResult = await db.execute('SELECT id, name, is_visible FROM puzzles ORDER BY id');
  res.render('competition_form', {
    competition: null,
    allPuzzles: puzzlesResult.rows,
    selectedPuzzleIds: [],
    isEdit: false,
    username: req.session.username,
    isStaff: true
  });
});

// 处理创建比赛（staff）
app.post('/competitions', requireAuth, requireStaff, async (req, res) => {
  const { name, start_time, end_time, puzzle_ids = [] } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).send('比赛名称不能为空');
  }
  if (!start_time || !end_time) {
    return res.status(400).send('请设置开始和结束时间');
  }
  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).send('结束时间必须晚于开始时间');
  }

  const insertResult = await db.execute({
    sql: 'INSERT INTO competitions (name, start_time, end_time) VALUES (?, ?, ?)',
    args: [name.trim(), start_time, end_time]
  });
  const compId = insertResult.lastInsertRowid;

  // 插入题目关联
  if (Array.isArray(puzzle_ids) && puzzle_ids.length > 0) {
    for (let i = 0; i < puzzle_ids.length; i++) {
      const pid = puzzle_ids[i];
      if (pid) {
        await db.execute({
          sql: 'INSERT OR IGNORE INTO competition_puzzles (competition_id, puzzle_id, sort_order) VALUES (?, ?, ?)',
          args: [compId, pid, i]
        });
      }
    }
  }

  res.redirect('/competitions');
});

// 显示比赛详情
app.get('/competitions/:id', requireAuth, async (req, res) => {
  const compId = req.params.id;
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  const competition = compResult.rows[0];
  if (!competition) {
    return res.status(404).send('比赛不存在');
  }

  const userId = req.session.userId;
  const isStaff = (req.session.role === 'root' || req.session.role === 'admin');

  // 获取报名状态
  const regResult = await db.execute({
    sql: 'SELECT * FROM registrations WHERE competition_id = ? AND user_id = ?',
    args: [compId, userId]
  });
  const isRegistered = regResult.rows.length > 0;

  // 获取题目列表
  const puzzlesResult = await db.execute(`
    SELECT p.id, p.name, p.tags, p.is_visible,
           cp.sort_order
    FROM competition_puzzles cp
    JOIN puzzles p ON p.id = cp.puzzle_id
    WHERE cp.competition_id = ?
    ORDER BY cp.sort_order, p.id
  `, [compId]);
  const puzzles = puzzlesResult.rows;

  const now = new Date();
  const startTime = new Date(competition.start_time);
  const endTime = new Date(competition.end_time);
  const isActive = now >= startTime && now <= endTime;

  // 判断用户是否可以查看题目（已报名且比赛进行中）
  let canViewPuzzles = false;
  if (isStaff) canViewPuzzles = true;
  else if (isRegistered && isActive) canViewPuzzles = true;

  res.render('competition_detail', {
    competition,
    puzzles,
    isRegistered,
    isActive,
    canViewPuzzles,
    isStaff,
    username: req.session.username
  });
});

// 报名比赛
app.post('/competitions/:id/register', requireAuth, async (req, res) => {
  const compId = req.params.id;
  const userId = req.session.userId;
  // 检查比赛是否存在
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  if (compResult.rows.length === 0) {
    return res.status(404).send('比赛不存在');
  }
  // 检查是否已报名
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

// 显示编辑比赛表单（staff）
app.get('/competitions/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const compId = req.params.id;
  const compResult = await db.execute({
    sql: 'SELECT * FROM competitions WHERE id = ?',
    args: [compId]
  });
  const competition = compResult.rows[0];
  if (!competition) {
    return res.status(404).send('比赛不存在');
  }

  // 获取已选题目ID
  const selectedResult = await db.execute({
    sql: 'SELECT puzzle_id FROM competition_puzzles WHERE competition_id = ?',
    args: [compId]
  });
  const selectedPuzzleIds = selectedResult.rows.map(r => r.puzzle_id);

  // 获取所有题目
  const puzzlesResult = await db.execute('SELECT id, name, is_visible FROM puzzles ORDER BY id');

  res.render('competition_form', {
    competition,
    allPuzzles: puzzlesResult.rows,
    selectedPuzzleIds,
    isEdit: true,
    username: req.session.username,
    isStaff: true
  });
});

// 处理编辑比赛（staff）
app.post('/competitions/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const compId = req.params.id;
  const { name, start_time, end_time, puzzle_ids = [] } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).send('比赛名称不能为空');
  }
  if (!start_time || !end_time) {
    return res.status(400).send('请设置开始和结束时间');
  }
  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).send('结束时间必须晚于开始时间');
  }

  // 更新比赛信息
  await db.execute({
    sql: 'UPDATE competitions SET name = ?, start_time = ?, end_time = ? WHERE id = ?',
    args: [name.trim(), start_time, end_time, compId]
  });

  // 重新设置题目关联
  await db.execute({
    sql: 'DELETE FROM competition_puzzles WHERE competition_id = ?',
    args: [compId]
  });
  if (Array.isArray(puzzle_ids) && puzzle_ids.length > 0) {
    for (let i = 0; i < puzzle_ids.length; i++) {
      const pid = puzzle_ids[i];
      if (pid) {
        await db.execute({
          sql: 'INSERT OR IGNORE INTO competition_puzzles (competition_id, puzzle_id, sort_order) VALUES (?, ?, ?)',
          args: [compId, pid, i]
        });
      }
    }
  }

  res.redirect(`/competitions/${compId}`);
});

// 删除比赛（staff）
app.post('/competitions/:id/delete', requireAuth, requireStaff, async (req, res) => {
  const compId = req.params.id;
  await db.execute({
    sql: 'DELETE FROM competitions WHERE id = ?',
    args: [compId]
  });
  res.redirect('/competitions');
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
  const userId = req.params.id;
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
  const userId = req.params.id;
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
  const userId = req.params.id;
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