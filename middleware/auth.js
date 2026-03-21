const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.split(' ')[1];
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Не авторизован' });
    return res.redirect('/login');
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Токен недействителен' });
    res.redirect('/login');
  }
};
