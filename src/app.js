const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { openDatabase } = require('./db');
const { SPORTS, US_STATES, stars } = require('./constants');

function createApp({
  dbPath = path.join(__dirname, '..', 'data', 'app.db'),
  uploadDir = path.join(__dirname, '..', 'uploads'),
  sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  maxUploadBytes = 500 * 1024 * 1024,
} = {}) {
  const db = openDatabase(dbPath);
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.db = db;
  app.locals.uploadDir = uploadDir;
  app.locals.maxUploadBytes = maxUploadBytes;
  app.locals.SPORTS = SPORTS;
  app.locals.US_STATES = US_STATES;
  app.locals.stars = stars;

  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );

  app.use((req, res, next) => {
    req.user = req.session.userId
      ? db.prepare('SELECT id, email, role, name FROM users WHERE id = ?').get(req.session.userId)
      : null;
    res.locals.currentUser = req.user;
    res.locals.flash = req.session.flash;
    delete req.session.flash;
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/profile'));
  app.use(require('./routes/videos'));
  app.use(require('./routes/athletes'));
  app.use(require('./routes/visits'));

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const recent = db
      .prepare(
        `SELECT v.id, v.title, v.sport, v.filename, v.mime_type, u.name AS athlete_name, u.id AS athlete_id
         FROM videos v JOIN users u ON u.id = v.athlete_id
         ORDER BY v.created_at DESC, v.id DESC LIMIT 6`
      )
      .all();
    res.render('home', { title: 'Home', recent });
  });

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).render('error', { title: 'Error', message: err.expose ? err.message : 'Something went wrong.' });
  });

  return app;
}

module.exports = { createApp };
