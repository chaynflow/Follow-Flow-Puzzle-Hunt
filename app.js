// app.js
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');

const app = express();
const PORT = 3000;

// 中间件
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1天
}));

// 认证中间件
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.redirect('/login');
}

// 管理员权限中间件
function requireRoot(req, res, next) {
  if (req.session && req.session.role === 'root') {
    return next();
  }
  res.status(403).send('无权限访问');
}

// 路由
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
app.post('/register', (req, res) => {
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

  const userExists = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (userExists) {
    return res.render('register', { error: '用户名已存在' });
  }

  const emailExists = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (emailExists) {
    return res.render('register', { error: '邮箱已被注册' });
  }

  const saltRounds = 10;
  const passwordHash = bcrypt.hashSync(password, saltRounds);
  db.prepare('INSERT INTO users (username, email, password_hash, is_approved, role) VALUES (?, ?, ?, 0, ?)')
    .run(username, email, passwordHash, 'user');

  res.redirect('/login?registered=1');
});

// 登录页面
app.get('/login', (req, res) => {
  const registered = req.query.registered === '1';
  res.render('login', { error: null, registered });
});

// 登录处理
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: '用户名和密码不能为空', registered: false });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
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

// 仪表板（需要登录）
app.get('/dashboard', requireAuth, (req, res) => {
  const isRoot = req.session.role === 'root';
  const puzzles = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM intermediate_answers ia WHERE ia.puzzle_id = p.id) AS inter_count,
           (SELECT COUNT(*) FROM hints h WHERE h.puzzle_id = p.id) AS hint_count
    FROM puzzles p
    ORDER BY p.created_at DESC
  `).all();
  res.render('dashboard', { username: req.session.username, puzzles, isRoot, userRole: req.session.role });
});

// 添加题目（仅 root）
app.post('/puzzles', requireAuth, requireRoot, (req, res) => {
  const {
    name = '',
    tags = '',
    description = '',
    answer,
    inter_answers = [],
    inter_infos = [],
    hints = []
  } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).send('题目名称不能为空');
  }
  if (!answer || answer.trim() === '') {
    return res.status(400).send('答案不能为空');
  }

  const insertPuzzle = db.prepare('INSERT INTO puzzles (name, tags, description, answer) VALUES (?, ?, ?, ?)');
  const puzzleResult = insertPuzzle.run(name.trim(), tags.trim(), description.trim(), answer.trim());
  const puzzleId = puzzleResult.lastInsertRowid;

  if (Array.isArray(inter_answers) && inter_answers.length > 0) {
    const insertInter = db.prepare('INSERT INTO intermediate_answers (puzzle_id, answer, info) VALUES (?, ?, ?)');
    inter_answers.forEach((ans, index) => {
      if (ans && ans.trim() !== '') {
        const info = inter_infos[index] || '';
        insertInter.run(puzzleId, ans.trim(), info.trim());
      }
    });
  }

  if (Array.isArray(hints) && hints.length > 0) {
    const insertHint = db.prepare('INSERT INTO hints (puzzle_id, hint_text) VALUES (?, ?)');
    hints.forEach(hint => {
      if (hint && hint.trim() !== '') {
        insertHint.run(puzzleId, hint.trim());
      }
    });
  }

  res.redirect('/dashboard');
});

// 删除谜题（仅 root）
app.post('/puzzles/:id/delete', requireAuth, requireRoot, (req, res) => {
  db.prepare('DELETE FROM puzzles WHERE id = ?').run(req.params.id);
  res.redirect('/dashboard');
});

// 谜题详情页（需要登录）
app.get('/puzzles/:id', requireAuth, (req, res) => {
  const puzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(req.params.id);
  if (!puzzle) {
    return res.status(404).send('谜题不存在');
  }
  const intermediateAnswers = db.prepare('SELECT * FROM intermediate_answers WHERE puzzle_id = ?').all(puzzle.id);
  const hints = db.prepare('SELECT * FROM hints WHERE puzzle_id = ?').all(puzzle.id);

  const result = req.query.result === 'correct' ? 'correct' :
                 req.query.result === 'incorrect' ? 'incorrect' :
                 req.query.result === 'intermediate' ? 'intermediate' : null;
  const intermediateInfo = req.query.intermediate_info || '';

  const isRoot = req.session.role === 'root';
  res.render('puzzle', { puzzle, intermediateAnswers, hints, result, intermediateInfo, username: req.session.username, isRoot });
});

// 提交答案（需要登录）
app.post('/puzzles/:id/answer', requireAuth, (req, res) => {
  const puzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(req.params.id);
  if (!puzzle) {
    return res.status(404).send('谜题不存在');
  }
  const submittedAnswer = req.body.answer ? req.body.answer.trim().toLowerCase() : '';
  const finalAnswer = puzzle.answer.trim().toLowerCase();

  if (submittedAnswer === finalAnswer) {
    return res.redirect(`/puzzles/${puzzle.id}?result=correct`);
  }

  const intermediateAnswers = db.prepare('SELECT * FROM intermediate_answers WHERE puzzle_id = ?').all(puzzle.id);
  for (const inter of intermediateAnswers) {
    if (submittedAnswer === inter.answer.trim().toLowerCase()) {
      const info = inter.info || '';
      const infoParam = encodeURIComponent(info);
      return res.redirect(`/puzzles/${puzzle.id}?result=intermediate&intermediate_info=${infoParam}`);
    }
  }

  return res.redirect(`/puzzles/${puzzle.id}?result=incorrect`);
});

// 用户管理页面（仅 root）
app.get('/admin/users', requireAuth, requireRoot, (req, res) => {
  const users = db.prepare('SELECT id, username, email, is_approved, role FROM users ORDER BY id').all();
  res.render('admin_users', { users, username: req.session.username });
});

// 批准用户（仅 root）
app.post('/admin/users/:id/approve', requireAuth, requireRoot, (req, res) => {
  db.prepare('UPDATE users SET is_approved = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/users');
});

// 删除用户（仅 root，不能删除 root 自己）
app.post('/admin/users/:id/delete', requireAuth, requireRoot, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user && user.role !== 'root') {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/users');
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});