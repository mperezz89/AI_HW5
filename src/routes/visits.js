const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const {
  missingPreferredFields,
  PREFERRED_ATHLETE_FIELDS,
  missingCoachFields,
  PREFERRED_COACH_FIELDS,
} = require('../constants');
const { nowLocal, upcomingSlots } = require('../calendar');

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
                v.title AS video_title, s.starts_at, s.duration_minutes, s.location,
                (SELECT COUNT(*) FROM visit_slots o WHERE o.coach_id = r.coach_id AND o.starts_at > ?) AS open_times
         FROM visit_requests r
         JOIN users u ON u.id = r.coach_id
         LEFT JOIN coach_profiles c ON c.user_id = r.coach_id
         LEFT JOIN videos v ON v.id = r.video_id
         LEFT JOIN visit_slots s ON s.id = r.slot_id
         WHERE r.athlete_id = ?
         ORDER BY r.status = 'pending' DESC, r.status = 'accepted' DESC, s.starts_at, r.created_at DESC, r.id DESC`
      )
      .all(nowLocal(), req.user.id);
    const totalViews = videos.reduce((sum, v) => sum + v.views, 0);
    const profile = db.prepare('SELECT * FROM athlete_profiles WHERE user_id = ?').get(req.user.id) || {};
    const missing = missingPreferredFields(profile);
    return res.render('dashboard-athlete', {
      title: 'Dashboard',
      videos,
      requests,
      totalViews,
      profile,
      missing,
      totalFields: PREFERRED_ATHLETE_FIELDS.length,
    });
  }

  const requests = db
    .prepare(
      `SELECT r.*, u.name AS athlete_name, v.title AS video_title, p.sport, p.position, p.grad_year,
              s.starts_at, s.duration_minutes
       FROM visit_requests r
       JOIN users u ON u.id = r.athlete_id
       LEFT JOIN athlete_profiles p ON p.user_id = r.athlete_id
       LEFT JOIN videos v ON v.id = r.video_id
       LEFT JOIN visit_slots s ON s.id = r.slot_id
       WHERE r.coach_id = ?
       ORDER BY r.created_at DESC, r.id DESC`
    )
    .all(req.user.id);
  const profile =
    db
      .prepare('SELECT c.*, t.team_code FROM coach_profiles c LEFT JOIN teams t ON t.id = c.team_id WHERE c.user_id = ?')
      .get(req.user.id) || {};
  const missing = missingCoachFields(profile);
  const openTimes = upcomingSlots(db, req.user.id, { openOnly: true }).length;
  res.render('dashboard-coach', {
    title: 'Dashboard',
    requests,
    profile,
    openTimes,
    missing,
    totalFields: PREFERRED_COACH_FIELDS.length,
  });
});

router.post('/athletes/:id/visit-requests', requireRole('coach'), (req, res, next) => {
  const db = req.app.locals.db;
  const athlete = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'athlete'").get(req.params.id);
  if (!athlete) return next();

  const message = (req.body.message || '').trim();
  let videoId = req.body.video_id ? Number(req.body.video_id) : null;
  if (videoId && !db.prepare('SELECT 1 FROM videos WHERE id = ? AND athlete_id = ?').get(videoId, athlete.id)) {
    videoId = null;
  }

  const back = `/athletes/${athlete.id}`;
  if (!message) {
    req.session.flash = 'Please include a message with your visit invitation.';
    return res.redirect(back);
  }
  const open = db
    .prepare(
      `SELECT 1 FROM visit_requests r LEFT JOIN visit_slots s ON s.id = r.slot_id
       WHERE r.coach_id = ? AND r.athlete_id = ?
         AND (r.status = 'pending' OR (r.status = 'accepted' AND s.starts_at > ?))`
    )
    .get(req.user.id, athlete.id, nowLocal());
  if (open) {
    req.session.flash = 'You already have an open invitation or upcoming visit with this athlete.';
    return res.redirect(back);
  }

  db.prepare(
    'INSERT INTO visit_requests (coach_id, athlete_id, video_id, message) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, athlete.id, videoId, message);

  req.session.flash = 'Invitation sent! Your visit calendar is now open to this athlete.';
  res.redirect(back);
});

// Athletes accept an invitation by booking a time (see routes/calendar.js); this handles declining.
router.post('/visit-requests/:id/respond', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const request = db
    .prepare('SELECT * FROM visit_requests WHERE id = ? AND athlete_id = ?')
    .get(req.params.id, req.user.id);
  if (!request) return next();

  if (req.body.decision !== 'decline' || request.status !== 'pending') {
    req.session.flash = 'That invitation can no longer be updated.';
    return res.redirect('/dashboard');
  }

  db.prepare(
    "UPDATE visit_requests SET status = 'declined', response_message = ?, responded_at = datetime('now') WHERE id = ?"
  ).run((req.body.response_message || '').trim() || null, request.id);

  req.session.flash = 'Visit invitation declined.';
  res.redirect('/dashboard');
});

module.exports = router;
