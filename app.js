// app.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { db, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: HTML 转义
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

// Helper: Markdown 图片渲染
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

// 管理员权限（root/admin）
function requireStaff(req, res, next) {
  if (req.session && (req.session.role === 'root' || req.session.role === 'admin')) {
    return next();
  }
  res.status(403).send('无权限访问');
}

// 仅 root
function requireRoot(req, res, next) {
  if (req.session && req.session.role === 'root') {
    return next();
  }
  res.status(403).send('无权限访问');
}

// 检查用户是否可以查看某题目（考虑比赛隐藏题目的特殊情况）
async function canUserViewPuzzle(userId, role, puzzleId) {
  // Staff 总是可以查看
  if (role === 'root' || role === 'admin') {
    return true;
  }

  // 获取题目
  const puzzleResult = await db.execute({
    sql: 'SELECT is_visible FROM puzzles WHERE id = ?',
    args: [puzzleId]
  });
  if (puzzleResult.rows.length === 0) {
    return false; // 题目不存在
  }
  const puzzle = puzzleResult.rows[0];

  // 如果题目可见，直接允许
  if (puzzle.is_visible === 1) {
    return true;
  }

  // 题目隐藏，检查用户是否报名了进行中的比赛且该比赛包含此题目
  const now = new Date();
  const nowIso = now.toISOString(); // 使用 ISO 字符串，但 start_time/end_time 存储的是 'YYYY-MM-DDTHH:mm'，可能不含秒和时区。我们使用 Date 解析比较。
  // 查询包含该 puzzle 的进行中比赛
  const contestsResult = await db.execute(`
    SELECT c.id, c.start_time, c.end_time
    FROM contests c
    JOIN contest_puzzles cp ON c.id = cp.contest_id
    WHERE cp.puzzle_id = ?
  `, [puzzleId]);

  for (const contest of contestsResult.rows) {
    const startTime = new Date(contest.start_time);
    const endTime = new Date(contest.end_time);
    if (now >= startTime && now <= endTime) {
      // 比赛进行中，检查用户是否报名
      const participantResult = await db.execute({
        sql: 'SELECT 1 FROM contest_participants WHERE contest_id = ? AND user_id = ?',
        args: [contest.id, userId]
      });
      if (participantResult.rows.length > 0) {
        return true;
      }
    }
  }

  return false;
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
    // 普通用户：显示可见题目，以及比赛期间可访问的隐藏题目（通过报名）
    puzzlesResult = await db.execute(`
      SELECT DISTINCT p.*,
             (SELECT COUNT(*) FROM intermediate_answers ia WHERE ia.puzzle_id = p.id) AS inter_count,
             (SELECT COUNT(*) FROM hints h WHERE h.puzzle_id = p.id) AS hint_count
      FROM puzzles p
      WHERE p.is_visible = 1
         OR p.id IN (
              SELECT cp.puzzle_id
              FROM contest_puzzles cp
              JOIN contests c ON cp.contest_id = c.id
              JOIN contest_participants pcp ON cp.contest_id = pcp.contest_id AND pcp.user_id = ?
              WHERE datetime('now') BETWEEN c.start_time AND c.end_time
          )
      ORDER BY p.created_at DESC
    `, [req.session.userId]);
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

// ==================== 比赛相关路由 ====================

// 比赛列表（所有已登录用户）
// 比赛列表
app.get('/contests', requireAuth, async (req, res) => {
  try {
    const contestsResult = await db.execute(`
      SELECT c.*,
             (SELECT COUNT(*) FROM contest_puzzles cp WHERE cp.contest_id = c.id) AS puzzle_count,
             (SELECT COUNT(*) FROM contest_participants cp2 WHERE cp2.contest_id = c.id) AS participant_count
      FROM contests c
      ORDER BY c.start_time DESC
    `);
    const contests = contestsResult.rows;

    // 在服务端计算每个比赛的状态
    const now = new Date();
    const contestsWithStatus = contests.map(contest => {
      const start = new Date(contest.start_time);
      const end = new Date(contest.end_time);
      let status = 'upcoming';
      if (now >= start && now <= end) status = 'active';
      else if (now > end) status = 'ended';
      return { ...contest, status };
    });

    res.render('contests', {
      contests: contestsWithStatus,
      username: req.session.username,
      isStaff: req.session.role === 'root' || req.session.role === 'admin'
    });
  } catch (err) {
    console.error('加载比赛列表错误:', err);
    res.status(500).send('加载比赛列表失败，请检查服务器日志');
  }
});

// 显示创建比赛表单（staff）
app.get('/contests/new', requireAuth, requireStaff, async (req, res) => {
  // 获取所有题目（包括隐藏）供选择
  const puzzlesResult = await db.execute('SELECT id, name, is_visible FROM puzzles ORDER BY id');
  res.render('contest_form', {
    contest: null,
    puzzles: puzzlesResult.rows,
    selectedPuzzleIds: [],
    isEdit: false,
    isStaff: true
  });
});

// 处理创建比赛
// 处理创建比赛
app.post('/contests', requireAuth, requireStaff, async (req, res) => {
  const { name, description, start_time, end_time, puzzle_ids } = req.body;
  if (!name || !start_time || !end_time) {
    return res.status(400).send('比赛名称、开始时间和结束时间不能为空');
  }

  // 确保 puzzle_ids 是数组（若未传递则设为空数组，若为字符串则包装为数组）
  let puzzleIds = Array.isArray(puzzle_ids) ? puzzle_ids : [];
  if (typeof puzzle_ids === 'string') {
    puzzleIds = [puzzle_ids];
  }
  console.log('创建比赛 puzzleIds:', puzzleIds); // 调试用，可删除

  const insertResult = await db.execute({
    sql: 'INSERT INTO contests (name, description, start_time, end_time) VALUES (?, ?, ?, ?)',
    args: [name.trim(), description ? description.trim() : '', start_time, end_time]
  });
  const contestId = insertResult.lastInsertRowid;

  // 插入题目关联
  for (const puzzleId of puzzleIds) {
    const numericPuzzleId = parseInt(puzzleId, 10);
    if (isNaN(numericPuzzleId)) continue;
    await db.execute({
      sql: 'INSERT OR IGNORE INTO contest_puzzles (contest_id, puzzle_id) VALUES (?, ?)',
      args: [contestId, numericPuzzleId]
    });
  }

  res.redirect('/contests');
});

// 显示编辑比赛表单（staff）
app.get('/contests/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const contestResult = await db.execute({
    sql: 'SELECT * FROM contests WHERE id = ?',
    args: [req.params.id]
  });
  const contest = contestResult.rows[0];
  if (!contest) {
    return res.status(404).send('比赛不存在');
  }

  // 获取已选题目
  const selectedResult = await db.execute({
    sql: 'SELECT puzzle_id FROM contest_puzzles WHERE contest_id = ?',
    args: [contest.id]
  });
  const selectedPuzzleIds = selectedResult.rows.map(row => row.puzzle_id);

  const puzzlesResult = await db.execute('SELECT id, name, is_visible FROM puzzles ORDER BY id');
  res.render('contest_form', {
    contest,
    puzzles: puzzlesResult.rows,
    selectedPuzzleIds,
    isEdit: true,
    isStaff: true
  });
});

// 处理编辑比赛
// 处理编辑比赛
app.post('/contests/:id/edit', requireAuth, requireStaff, async (req, res) => {
  const contestId = req.params.id;
  const { name, description, start_time, end_time, puzzle_ids } = req.body;
  if (!name || !start_time || !end_time) {
    return res.status(400).send('比赛名称、开始时间和结束时间不能为空');
  }

  let puzzleIds = Array.isArray(puzzle_ids) ? puzzle_ids : [];
  if (typeof puzzle_ids === 'string') {
    puzzleIds = [puzzle_ids];
  }

  await db.execute({
    sql: 'UPDATE contests SET name = ?, description = ?, start_time = ?, end_time = ? WHERE id = ?',
    args: [name.trim(), description ? description.trim() : '', start_time, end_time, contestId]
  });

  // 更新题目关联：先删除旧的，再插入新的
  await db.execute({
    sql: 'DELETE FROM contest_puzzles WHERE contest_id = ?',
    args: [contestId]
  });
  for (const puzzleId of puzzleIds) {
    const numericPuzzleId = parseInt(puzzleId, 10);
    if (isNaN(numericPuzzleId)) continue;
    await db.execute({
      sql: 'INSERT OR IGNORE INTO contest_puzzles (contest_id, puzzle_id) VALUES (?, ?)',
      args: [contestId, numericPuzzleId]
    });
  }

  res.redirect('/contests');
});

// 删除比赛
app.post('/contests/:id/delete', requireAuth, requireStaff, async (req, res) => {
  await db.execute({
    sql: 'DELETE FROM contests WHERE id = ?',
    args: [req.params.id]
  });
  res.redirect('/contests');
});

// 比赛详情
app.get('/contests/:id', requireAuth, async (req, res) => {
  const contestResult = await db.execute({
    sql: 'SELECT * FROM contests WHERE id = ?',
    args: [req.params.id]
  });
  const contest = contestResult.rows[0];
  if (!contest) {
    return res.status(404).send('比赛不存在');
  }

  const isStaff = req.session.role === 'root' || req.session.role === 'admin';
  const userId = req.session.userId;

  // 检查用户是否报名
  const participantResult = await db.execute({
    sql: 'SELECT 1 FROM contest_participants WHERE contest_id = ? AND user_id = ?',
    args: [contest.id, userId]
  });
  const isParticipant = participantResult.rows.length > 0;

  // 获取比赛包含的题目
  const puzzlesResult = await db.execute(`
    SELECT p.id, p.name, p.tags, p.is_visible
    FROM contest_puzzles cp
    JOIN puzzles p ON cp.puzzle_id = p.id
    WHERE cp.contest_id = ?
    ORDER BY p.id
  `, [contest.id]);
  const contestPuzzles = puzzlesResult.rows;

  // 比赛状态
  const now = new Date();
  const startTime = new Date(contest.start_time);
  const endTime = new Date(contest.end_time);
  let status = 'upcoming'; // 未开始
  if (now >= startTime && now <= endTime) {
    status = 'active'; // 进行中
  } else if (now > endTime) {
    status = 'ended'; // 已结束
  }

  res.render('contest', {
    contest,
    isStaff,
    isParticipant,
    contestPuzzles,
    status,
    username: req.session.username
  });
});

// 报名比赛
app.post('/contests/:id/register', requireAuth, async (req, res) => {
  const contestId = req.params.id;
  const userId = req.session.userId;
  // 检查比赛是否存在
  const contestResult = await db.execute({
    sql: 'SELECT id FROM contests WHERE id = ?',
    args: [contestId]
  });
  if (contestResult.rows.length === 0) {
    return res.status(404).send('比赛不存在');
  }
  // 插入报名（忽略重复）
  await db.execute({
    sql: 'INSERT OR IGNORE INTO contest_participants (contest_id, user_id) VALUES (?, ?)',
    args: [contestId, userId]
  });
  res.redirect(`/contests/${contestId}`);
});

// 取消报名
app.post('/contests/:id/unregister', requireAuth, async (req, res) => {
  const contestId = req.params.id;
  const userId = req.session.userId;
  await db.execute({
    sql: 'DELETE FROM contest_participants WHERE contest_id = ? AND user_id = ?',
    args: [contestId, userId]
  });
  res.redirect(`/contests/${contestId}`);
});

// ==================== 谜题相关路由 ====================

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

// 处理添加谜题
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

// 处理编辑谜题
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

  // 权限检查
  const allowed = await canUserViewPuzzle(req.session.userId, req.session.role, puzzle.id);
  if (!allowed) {
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

  // 处理 Markdown 图片
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
    isRoot: req.session.role === 'root',
    isAdmin: req.session.role === 'admin',
    isStaff: req.session.role === 'root' || req.session.role === 'admin'
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

  // 权限检查
  const allowed = await canUserViewPuzzle(req.session.userId, req.session.role, puzzle.id);
  if (!allowed) {
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

// ==================== 用户管理（原有） ====================
app.get('/admin/users', requireAuth, requireStaff, async (req, res) => {
  const usersResult = await db.execute('SELECT id, username, email, is_approved, role FROM users ORDER BY id');
  res.render('admin_users', {
    users: usersResult.rows,
    username: req.session.username,
    currentUserRole: req.session.role
  });
});

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
  if (user.role === 'root') {
    return res.redirect('/admin/users');
  }
  await db.execute({
    sql: 'UPDATE users SET is_approved = 1 WHERE id = ?',
    args: [userId]
  });
  res.redirect('/admin/users');
});

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

app.post('/admin/users/:id/set-admin', requireAuth, requireRoot, async (req, res) => {
  const userId = req.params.id;
  const { action } = req.body;
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