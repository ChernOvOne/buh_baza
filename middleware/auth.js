const jwt = require('jsonwebtoken');
const db = require('../database/db');

function authMiddleware(req, res, next, minRole = null) {
  const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Не авторизован' });
    return res.redirect('/login');
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Refresh user from DB to get current role/active status
    if (decoded.user_id) {
      const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(decoded.user_id);
      if (!user) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Пользователь не найден' });
        return res.redirect('/login');
      }
      req.user = { id: user.id, role: user.role, username: user.username || user.tg_username, tg_id: user.tg_id };
      // Update last_seen (throttled — only if >5min old)
      const last = user.last_seen ? new Date(user.last_seen) : null;
      if (!last || (Date.now() - last.getTime()) > 5 * 60 * 1000) {
        db.prepare('UPDATE users SET last_seen=datetime("now") WHERE id=?').run(user.id);
      }
    } else {
      // Legacy token (old admin token without user_id)
      req.user = { id: 0, role: 'admin', username: 'admin' };
    }
    if (minRole && !hasRole(req.user.role, minRole)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Недостаточно прав' });
      return res.redirect('/');
    }
    next();
  } catch {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Токен недействителен' });
    res.redirect('/login');
  }
}

const ROLES = { viewer: 0, editor: 1, admin: 2 };
function hasRole(userRole, minRole) {
  return (ROLES[userRole] || 0) >= (ROLES[minRole] || 0);
}

const auth       = (req, res, next) => authMiddleware(req, res, next, null);
const authEditor = (req, res, next) => authMiddleware(req, res, next, 'editor');
const authAdmin  = (req, res, next) => authMiddleware(req, res, next, 'admin');

module.exports = auth;
module.exports.authEditor = authEditor;
module.exports.authAdmin = authAdmin;
module.exports.hasRole = hasRole;
