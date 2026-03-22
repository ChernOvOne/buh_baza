const jwt = require('jsonwebtoken');
const db  = require('../database/db');

const ROLES = { none: -1, viewer: 0, editor: 1, admin: 2 };
function hasRole(userRole, minRole) {
  return (ROLES[userRole] ?? 0) >= (ROLES[minRole] ?? 0);
}

function getCookieOpts() {
  const isHttps = process.env.COOKIE_SECURE === 'true'
    || process.env.NODE_ENV === 'production'
    || (process.env.SITE_URL || '').startsWith('https');
  return {
    httpOnly: true,
    maxAge: 30 * 24 * 3600 * 1000,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
  };
}

function authMiddleware(req, res, next, minRole = null) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Не авторизован' });
    return res.redirect('/login');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
  } catch {
    res.clearCookie('token');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Токен недействителен' });
    return res.redirect('/login');
  }

  if (decoded.partner_id) {
    let partner;
    try { partner = db.prepare('SELECT id,name,access_role,active FROM partners WHERE id=?').get(decoded.partner_id); } catch {}
    if (!partner || !partner.active) {
      res.clearCookie('token');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Аккаунт не найден' });
      return res.redirect('/login');
    }
    req.user = { id: partner.id, role: partner.access_role, name: partner.name };
    setImmediate(() => {
      try { db.prepare('UPDATE partners SET last_seen=datetime("now") WHERE id=?').run(partner.id); } catch {}
    });
  } else if (decoded.user_id || decoded.admin) {
    // Legacy tokens
    req.user = { id: decoded.user_id || 0, role: 'admin', name: 'admin' };
  } else {
    res.clearCookie('token');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Неверный токен' });
    return res.redirect('/login');
  }

  if (minRole && !hasRole(req.user.role, minRole)) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Недостаточно прав' });
    return res.redirect('/');
  }
  next();
}

const auth       = (req, res, next) => authMiddleware(req, res, next, null);
const authEditor = (req, res, next) => authMiddleware(req, res, next, 'editor');
const authAdmin  = (req, res, next) => authMiddleware(req, res, next, 'admin');

module.exports = auth;
module.exports.authEditor  = authEditor;
module.exports.authAdmin   = authAdmin;
module.exports.hasRole     = hasRole;
module.exports.getCookieOpts = getCookieOpts;
