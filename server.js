require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const QRCode = require('qrcode');

const {
  db, bcrypt, ADMIN_USER,
  roomStmts, createRoom,
  qStmts,
  pollStmts, createPoll,
} = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ── Middleware ───────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'nowsay-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
});

app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Share session with Socket.IO
io.engine.use(sessionMiddleware);

// ── Auth helpers ────────────────────────────────────────────
function isAdmin(req) {
  return req.session && req.session.admin === true;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.redirect('/login');
  next();
}

// ── Public routes ───────────────────────────────────────────

// Landing
app.get('/', (req, res) => {
  res.render('index');
});

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.render('login', { error: '입력을 확인하세요.' });

  const admin = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.render('login', { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  req.session.admin = true;
  res.redirect('/admin');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ── Admin routes ────────────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  const rooms = roomStmts.list.all();
  res.render('admin', { rooms });
});

// Create room
app.post('/admin/rooms', requireAdmin, (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/admin');
  createRoom(title);
  res.redirect('/admin');
});

// Toggle room active
app.post('/admin/rooms/:code/toggle', requireAdmin, (req, res) => {
  const room = roomStmts.getByCode.get(req.params.code);
  if (room) roomStmts.toggle.run(room.active ? 0 : 1, req.params.code);
  res.redirect('/admin');
});

// Delete room
app.post('/admin/rooms/:code/delete', requireAdmin, (req, res) => {
  roomStmts.delete.run(req.params.code);
  res.redirect('/admin');
});

// Admin room detail (manage questions + polls)
app.get('/admin/rooms/:code', requireAdmin, (req, res) => {
  const room = roomStmts.getByCode.get(req.params.code);
  if (!room) return res.status(404).send('방을 찾을 수 없습니다.');
  const questions = qStmts.listByRoom.all(req.params.code);
  const polls = pollStmts.listByRoom.all(req.params.code);
  for (const p of polls) {
    p.options = pollStmts.getOptions.all(p.id);
  }
  res.render('admin-room', { room, questions, polls });
});

// Create poll
app.post('/admin/rooms/:code/polls', requireAdmin, (req, res) => {
  const { question, options } = req.body;
  if (!question) return res.redirect(`/admin/rooms/${req.params.code}`);
  // options comes as "option1\noption2\n..." or array
  let optList = Array.isArray(options) ? options : (options || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (optList.length < 2) return res.redirect(`/admin/rooms/${req.params.code}`);
  const pollId = createPoll(req.params.code, question.trim(), optList);
  io.to(req.params.code).emit('poll:new', {
    id: pollId,
    question: question.trim(),
    options: pollStmts.getOptions.all(pollId),
    active: 1,
  });
  res.redirect(`/admin/rooms/${req.params.code}`);
});

// Toggle poll
app.post('/admin/rooms/:code/polls/:id/toggle', requireAdmin, (req, res) => {
  const poll = pollStmts.getById.get(req.params.id);
  if (poll) {
    const newState = poll.active ? 0 : 1;
    pollStmts.toggle.run(newState, req.params.id);
    io.to(req.params.code).emit('poll:toggle', { id: Number(req.params.id), active: newState });
  }
  res.redirect(`/admin/rooms/${req.params.code}`);
});

// Delete poll
app.post('/admin/rooms/:code/polls/:id/delete', requireAdmin, (req, res) => {
  pollStmts.delete.run(req.params.id);
  io.to(req.params.code).emit('poll:remove', { id: Number(req.params.id) });
  res.redirect(`/admin/rooms/${req.params.code}`);
});

// QR code endpoint
app.get('/qr/:code', async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/r/${req.params.code}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 256 });
    res.type('image/svg+xml').send(svg);
  } catch {
    res.status(500).send('QR 생성 실패');
  }
});

// ── Participant room (short URL) ────────────────────────────
app.get('/r/:code', (req, res) => {
  const room = roomStmts.getByCode.get(req.params.code);
  if (!room) return res.status(404).render('not-found');
  const questions = qStmts.listByRoom.all(req.params.code);
  const polls = pollStmts.listByRoom.all(req.params.code);
  for (const p of polls) {
    p.options = pollStmts.getOptions.all(p.id);
  }
  res.render('room', { room, questions, polls });
});

// ── Socket.IO ───────────────────────────────────────────────
io.on('connection', (socket) => {
  // Join room
  socket.on('join', (code) => {
    socket.join(code);
  });

  // New question
  socket.on('question:new', (data) => {
    const { roomCode, text, nickname } = data;
    if (!roomCode || !text || !text.trim()) return;
    const room = roomStmts.getByCode.get(roomCode);
    if (!room || !room.active) return;

    const safeText = text.trim().slice(0, 500);
    const safeName = (nickname || '').trim().slice(0, 20) || '익명';

    const info = qStmts.create.run(roomCode, safeText, safeName);
    const q = qStmts.get.get(info.lastInsertRowid);
    io.to(roomCode).emit('question:new', q);
  });

  // Like question
  socket.on('question:like', (data) => {
    const { id, roomCode } = data;
    if (!id) return;
    qStmts.like.run(id);
    const q = qStmts.get.get(id);
    if (q) io.to(roomCode).emit('question:updated', q);
  });

  // Admin: toggle answered
  socket.on('question:answered', (data) => {
    const { id, roomCode } = data;
    qStmts.toggleAnswered.run(id);
    const q = qStmts.get.get(id);
    if (q) io.to(roomCode).emit('question:updated', q);
  });

  // Admin: pin question
  socket.on('question:pin', (data) => {
    const { id, roomCode } = data;
    qStmts.togglePin.run(id);
    const q = qStmts.get.get(id);
    if (q) io.to(roomCode).emit('question:updated', q);
  });

  // Admin: delete question
  socket.on('question:delete', (data) => {
    const { id, roomCode } = data;
    qStmts.delete.run(id);
    io.to(roomCode).emit('question:removed', { id });
  });

  // Poll vote
  socket.on('poll:vote', (data) => {
    const { optionId, pollId, roomCode } = data;
    if (!optionId || !pollId || !roomCode) return;
    // Verify poll exists and is active
    const poll = pollStmts.getById.get(pollId);
    if (!poll || !poll.active) return;
    // Verify option belongs to this poll
    const opt = pollStmts.getOption.get(optionId);
    if (!opt || opt.poll_id !== Number(pollId)) return;
    pollStmts.vote.run(optionId);
    const options = pollStmts.getOptions.all(pollId);
    io.to(roomCode).emit('poll:updated', { pollId: Number(pollId), options });
  });
});

// ── Start ───────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`\n  🎤 NowSay 실행 중: http://localhost:${PORT}`);
  console.log(`  관리자 로그인: /login\n`);
});
