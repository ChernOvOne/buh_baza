const jwt = require('jsonwebtoken');
const db  = require('../database/db');

const ROLES = { viewer: 0, editor: 1, admin: 2 };

function hasRole(userRole, minRole) {
  return (ROLES[userRole] || 0) >= (ROLES[minRole] || 0);
}

function authMiddleware(req, res, next, minRole = null) {
  const token = req.cookies?.token
    || req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Не авторизован' });
    return res.redirect('/login');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_change_me');
  } catch (e) {
    // Токен протух или неверный
    res.clearCookie('token');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Токен недействителен' });
    return res.redirect('/login');
  }

  // Если в токене есть user_id — проверяем в БД
  if (decoded.user_id) {
    let user;
    try {
      user = db.prepare('SELECT id,role,username,tg_username,active FROM users WHERE id=?').get(decoded.user_id);
    } catch (e) {
      console.error('Auth DB error:', e.message);
    }

    if (!user || !user.active) {
      res.clearCookie('token');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Пользователь не найден' });
      return res.redirect('/login');
    }

    req.user = {
      id:       user.id,
      role:     user.role,
      username: user.username || user.tg_username || 'user_' + user.id,
    };

    // Обновляем last_seen асинхронно, не блокируя запрос
    setImmediate(() => {
      try {
        db.prepare('UPDATE users SET last_seen=datetime("now") WHERE id=?').run(user.id);
      } catch {}
    });

  } else {
    // Старый токен без user_id (legacy) — создаём виртуального admin
    req.user = { id: 0, role: decoded.role || 'admin', username: 'admin' };
  }

  // Проверяем минимальную роль
  if (minRole && !hasRole(req.user.role, minRole)) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Недостаточно прав' });
    return res.redirect('/');
  }

  next();
}

const auth       = (req, res, next) => authMiddleware(req, res, next, null);
const authEditor = (req, res, next) => authMiddleware(req, res, next, 'editor');
const authAdmin  = (req, res, next) => authMiddleware(req, res, next, 'admin');

module.exports       = auth;
module.exports.authEditor = authEditor;
module.exports.authAdmin  = authAdmin;
module.exports.hasRole    = hasRole;
