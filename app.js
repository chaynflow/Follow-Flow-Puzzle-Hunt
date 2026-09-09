// app.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { db, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

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

// 管理员权限中间件（root 或 admin）
function requireStaff(req, res, next) {
  if (req.session && (req.session.role === 'root' || req.session.role === 'admin')) {
    return next();
  }
  res.status(403).send('无权限访问');
}

// 仅 root 权限中间件
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

  // 插入谜题
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
  // 确认谜题存在
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

  // 更新谜题主表
  await db.execute({
    sql: 'UPDATE puzzles SET name = ?, tags = ?, description = ?, answer = ?, flavor_text = ?, is_visible = ? WHERE id = ?',
    args: [name.trim(), tags.trim(), description.trim(), answer.trim(), flavor_text.trim(), visibility, puzzleId]
  });

  // 删除旧的中间答案
  await db.execute({
    sql: 'DELETE FROM intermediate_answers WHERE puzzle_id = ?',
    args: [puzzleId]
  });
  // 删除旧的提示
  await db.execute({
    sql: 'DELETE FROM hints WHERE puzzle_id = ?',
    args: [puzzleId]
  });

  // 插入新的中间答案
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

  // 插入新的提示
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

// 谜题详情页
app.get('/puzzles/:id', requireAuth, async (req, res) => {
  const puzzleResult = await db.execute({
    sql: 'SELECT * FROM puzzles WHERE id = ?',
    args: [req.params.id]
  });
  const puzzle = puzzleResult.rows[0];
  if (!puzzle) {
    return res.status(404).send('谜题不存在');
  }

  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;
  if (!isStaff && puzzle.is_visible !== 1) {
    return res.status(404).send('谜题不存在或已隐藏');
  }

  const interResult = await db.execute({
    sql: 'SELECT * FROM intermediate_answers WHERE puzzle_id = ? ORDER BY sort_order, id',
    args: [puzzle.id]
  });
  const intermediateAnswers = interResult.rows;

  const hintsResult = await db.execute({
    sql: 'SELECT * FROM hints WHERE puzzle_id = ? ORDER BY sort_order, id',
    args: [puzzle.id]
  });
  const hints = hintsResult.rows;

  const result = req.query.result === 'correct' ? 'correct' :
                 req.query.result === 'incorrect' ? 'incorrect' :
                 req.query.result === 'intermediate' ? 'intermediate' : null;
  const intermediateInfo = req.query.intermediate_info || '';

  res.render('puzzle', {
    puzzle,
    intermediateAnswers,
    hints,
    result,
    intermediateInfo,
    username: req.session.username,
    isRoot,
    isAdmin,
    isStaff
  });
});

// 提交答案
app.post('/puzzles/:id/answer', requireAuth, async (req, res) => {
  const puzzleResult = await db.execute({
    sql: 'SELECT * FROM puzzles WHERE id = ?',
    args: [req.params.id]
  });
  const puzzle = puzzleResult.rows[0];
  if (!puzzle) {
    return res.status(404).send('谜题不存在');
  }

  const isRoot = req.session.role === 'root';
  const isAdmin = req.session.role === 'admin';
  const isStaff = isRoot || isAdmin;
  if (!isStaff && puzzle.is_visible !== 1) {
    return res.status(404).send('谜题不存在或已隐藏');
  }

  const submittedAnswer = req.body.answer ? req.body.answer.trim().toLowerCase() : '';
  const finalAnswer = puzzle.answer.trim().toLowerCase();

  if (submittedAnswer === finalAnswer) {
    return res.redirect(`/puzzles/${puzzle.id}?result=correct`);
  }

  const interResult = await db.execute({
    sql: 'SELECT * FROM intermediate_answers WHERE puzzle_id = ?',
    args: [puzzle.id]
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
  if (!user) {
    return res.status(404).send('用户不存在');
  }
  // 不允许批准 root 自己（root 应该已批准），但批准普通用户或 admin 均可
  if (user.role === 'root') {
    return res.redirect('/admin/users');
  }
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
  if (!user) {
    return res.status(404).send('用户不存在');
  }
  // root 可以删除除 root 外的任何用户
  if (req.session.role === 'root') {
    if (user.role !== 'root') {
      await db.execute({
        sql: 'DELETE FROM users WHERE id = ?',
        args: [userId]
      });
    }
  } else {
    // admin 只能删除 role 为 'user' 的用户
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
  const { action } = req.body; // 'promote' or 'demote'
  const userResult = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [userId]
  });
  const user = userResult.rows[0];
  if (!user) {
    return res.status(404).send('用户不存在');
  }
  if (user.role === 'root') {
    return res.redirect('/admin/users');
  }
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