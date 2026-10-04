const express = require('express');
const { hashPassword, verifyPassword } = require('../auth');

const router = express.Router();

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

router.get('/register', (req, res) => {
  res.render('register', { title: 'Sign up', error: null, form: { role: req.query.role || 'athlete' } });
});

router.post('/register', (req, res) => {
  const db = req.app.locals.db;
  const form = {
    name: (req.body.name || '').trim(),
    email: (req.body.email || '').trim().toLowerCase(),
    role: req.body.role,
  };
  const password = req.body.password || '';

  let error = null;
  if (!form.name || !form.email || !password) error = 'Name, email, and password are required.';
  else if (!['athlete', 'coach'].includes(form.role)) error = 'Choose whether you are an athlete or a coach.';
  else if (password.length < 8) error = 'Password must be at least 8 characters.';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) error = 'An account with that email already exists.';

  if (error) return res.status(400).render('register', { title: 'Sign up', error, form });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, ?, ?)')
    .run(form.email, hashPassword(password), form.role, form.name);
  const userId = Number(lastInsertRowid);
  const profileTable = form.role === 'athlete' ? 'athlete_profiles' : 'coach_profiles';
  db.prepare(`INSERT INTO ${profileTable} (user_id) VALUES (?)`).run(userId);

  req.session.regenerate(() => {
    req.session.userId = userId;
    req.session.flash = 'Welcome! Finish your profile so coaches can find you.';
    if (form.role === 'coach') req.session.flash = 'Welcome! Fill in your coach profile so athletes know who you are.';
    res.redirect('/profile/edit');
  });
});

router.get('/login', (req, res) => {
  res.render('login', { title: 'Log in', error: null, email: '', next: req.query.next || '' });
});

router.post('/login', (req, res) => {
  const db = req.app.locals.db;
  const email = (req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(req.body.password || '', user.password_hash)) {
    return res
      .status(401)
      .render('login', { title: 'Log in', error: 'Invalid email or password.', email, next: req.body.next || '' });
  }
  req.session.regenerate(() => {
    req.session.userId = user.id;
    res.redirect(safeNext(req.body.next));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
