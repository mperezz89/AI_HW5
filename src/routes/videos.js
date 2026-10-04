const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { requireRole } = require('../auth');
const { VIDEO_MIME_TYPES } = require('../constants');

const router = express.Router();

const EXTENSIONS = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };

function uploader(req, res, next) {
  const { uploadDir, maxUploadBytes } = req.app.locals;
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => cb(null, crypto.randomUUID() + EXTENSIONS[file.mimetype]),
    }),
    limits: { fileSize: maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (VIDEO_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
      const err = new Error('Only MP4, MOV, or WebM videos are allowed.');
      err.code = 'BAD_FILE_TYPE';
      cb(err);
    },
  }).single('video');

  upload(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Video is too large (max ${Math.round(maxUploadBytes / 1024 / 1024)} MB).`
        : err.code === 'BAD_FILE_TYPE'
          ? err.message
          : 'Upload failed. Please try again.';
    res.status(400).render('video-new', { title: 'Upload highlight', error: message, form: req.body || {} });
  });
}

router.get('/videos/new', requireRole('athlete'), (req, res) => {
  const profile = req.app.locals.db.prepare('SELECT sport FROM athlete_profiles WHERE user_id = ?').get(req.user.id);
  res.render('video-new', { title: 'Upload highlight', error: null, form: { sport: profile && profile.sport } });
});

router.post('/videos', requireRole('athlete'), uploader, (req, res) => {
  const db = req.app.locals.db;
  const form = req.body;
  const title = (form.title || '').trim();

  if (!req.file || !title) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res
      .status(400)
      .render('video-new', { title: 'Upload highlight', error: 'A title and a video file are required.', form });
  }

  const clean = (v) => ((v || '').trim() === '' ? null : v.trim());
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO videos (athlete_id, title, description, sport, opponent, game_date, filename, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      title,
      clean(form.description),
      clean(form.sport),
      clean(form.opponent),
      clean(form.game_date),
      req.file.filename,
      req.file.mimetype,
      req.file.size
    );

  req.session.flash = 'Highlight uploaded!';
  res.redirect(`/videos/${lastInsertRowid}`);
});

router.get('/videos/:id', (req, res, next) => {
  const db = req.app.locals.db;
  const video = db
    .prepare(
      `SELECT v.*, u.name AS athlete_name, p.position, p.grad_year, p.high_school, p.state
       FROM videos v
       JOIN users u ON u.id = v.athlete_id
       LEFT JOIN athlete_profiles p ON p.user_id = v.athlete_id
       WHERE v.id = ?`
    )
    .get(req.params.id);
  if (!video) return next();

  const isOwner = req.user && req.user.id === video.athlete_id;
  if (!isOwner) {
    db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(video.id);
    video.views += 1;
  }
  res.render('video-show', { title: video.title, video, isOwner });
});

router.post('/videos/:id/delete', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const video = db.prepare('SELECT * FROM videos WHERE id = ? AND athlete_id = ?').get(req.params.id, req.user.id);
  if (!video) return next();
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  fs.unlink(path.join(req.app.locals.uploadDir, video.filename), () => {});
  req.session.flash = 'Video deleted.';
  res.redirect('/dashboard');
});

// Serves uploaded files with HTTP range support so browsers can seek.
router.get('/media/:filename', (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const video = req.app.locals.db.prepare('SELECT 1 FROM videos WHERE filename = ?').get(filename);
  if (!video) return next();
  res.sendFile(filename, { root: req.app.locals.uploadDir });
});

module.exports = router;
