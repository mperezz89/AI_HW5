const express = require('express');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

router.get('/dashboard', requireAuth, (req, res) => {
  const db = req.app.locals.db;

  if (req.user.role === 'athlete') {
    const videos = db
      .prepare('SELECT * FROM videos WHERE athlete_id = ? ORDER BY created_at DESC, id DESC')
      .all(req.user.id);
    const requests = db
      .prepare(
        `SELECT r.*, u.name AS coach_name, u.email AS coach_email, c.school, c.title AS coach_title, c.division,
                v.title AS video_title
         FROM visit_requests r
         JOIN users u ON u.id = r.coach_id
         LEFT JOIN coach_profiles c ON c.user_id = r.coach_id
         LEFT JOIN videos v ON v.id = r.video_id
         WHERE r.athlete_id = ?
         ORDER BY r.status = 'pending' DESC, r.created_at DESC, r.id DESC`
      )
      .all(req.user.id);
    const totalViews = videos.reduce((sum, v) => sum + v.views, 0);
    return res.render('dashboard-athlete', { title: 'Dashboard', videos, requests, totalViews });
  }

  const requests = db
    .prepare(
      `SELECT r.*, u.name AS athlete_name, v.title AS video_title, p.sport, p.position, p.grad_year
       FROM visit_requests r
       JOIN users u ON u.id = r.athlete_id
       LEFT JOIN athlete_profiles p ON p.user_id = r.athlete_id
       LEFT JOIN videos v ON v.id = r.video_id
       WHERE r.coach_id = ?
       ORDER BY r.created_at DESC, r.id DESC`
    )
    .all(req.user.id);
  const profile = db.prepare('SELECT * FROM coach_profiles WHERE user_id = ?').get(req.user.id) || {};
  res.render('dashboard-coach', { title: 'Dashboard', requests, profile });
});

router.post('/athletes/:id/visit-requests', requireRole('coach'), (req, res, next) => {
  const db = req.app.locals.db;
  const athlete = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'athlete'").get(req.params.id);
  if (!athlete) return next();

  const message = (req.body.message || '').trim();
  const proposedDate = (req.body.proposed_date || '').trim() || null;
  let videoId = req.body.video_id ? Number(req.body.video_id) : null;
  if (videoId && !db.prepare('SELECT 1 FROM videos WHERE id = ? AND athlete_id = ?').get(videoId, athlete.id)) {
    videoId = null;
  }

  const back = `/athletes/${athlete.id}`;
  if (!message) {
    req.session.flash = 'Please include a message with your visit request.';
    return res.redirect(back);
  }
  const pending = db
    .prepare("SELECT 1 FROM visit_requests WHERE coach_id = ? AND athlete_id = ? AND status = 'pending'")
    .get(req.user.id, athlete.id);
  if (pending) {
    req.session.flash = 'You already have a pending visit request with this athlete.';
    return res.redirect(back);
  }

  db.prepare(
    'INSERT INTO visit_requests (coach_id, athlete_id, video_id, message, proposed_date) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, athlete.id, videoId, message, proposedDate);

  req.session.flash = 'Visit request sent!';
  res.redirect(back);
});

router.post('/visit-requests/:id/respond', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const request = db
    .prepare('SELECT * FROM visit_requests WHERE id = ? AND athlete_id = ?')
    .get(req.params.id, req.user.id);
  if (!request) return next();

  const status = req.body.decision === 'accept' ? 'accepted' : req.body.decision === 'decline' ? 'declined' : null;
  if (!status || request.status !== 'pending') {
    req.session.flash = 'That request can no longer be updated.';
    return res.redirect('/dashboard');
  }

  db.prepare(
    "UPDATE visit_requests SET status = ?, response_message = ?, responded_at = datetime('now') WHERE id = ?"
  ).run(status, (req.body.response_message || '').trim() || null, request.id);

  req.session.flash = status === 'accepted' ? 'Visit accepted — the coach can now see your contact info.' : 'Visit request declined.';
  res.redirect('/dashboard');
});

module.exports = router;
