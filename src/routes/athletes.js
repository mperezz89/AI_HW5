const express = require('express');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/athletes', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const filters = {
    q: (req.query.q || '').trim(),
    sport: req.query.sport || '',
    position: (req.query.position || '').trim(),
    grad_year: req.query.grad_year || '',
    state: req.query.state || '',
  };

  const where = ["u.role = 'athlete'"];
  const params = [];
  if (filters.q) {
    where.push('(u.name LIKE ? OR p.high_school LIKE ? OR p.city LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }
  if (filters.sport) {
    where.push('p.sport = ?');
    params.push(filters.sport);
  }
  if (filters.position) {
    where.push('p.position LIKE ?');
    params.push(`%${filters.position}%`);
  }
  if (filters.grad_year) {
    where.push('p.grad_year = ?');
    params.push(Number(filters.grad_year));
  }
  if (filters.state) {
    where.push('p.state = ?');
    params.push(filters.state);
  }

  const athletes = db
    .prepare(
      `SELECT u.id, u.name, p.sport, p.position, p.grad_year, p.high_school, p.city, p.state,
              COUNT(v.id) AS video_count, COALESCE(SUM(v.views), 0) AS total_views,
              (SELECT filename FROM videos WHERE athlete_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_filename,
              (SELECT mime_type FROM videos WHERE athlete_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_mime
       FROM users u
       LEFT JOIN athlete_profiles p ON p.user_id = u.id
       LEFT JOIN videos v ON v.athlete_id = u.id
       WHERE ${where.join(' AND ')}
       GROUP BY u.id
       ORDER BY video_count > 0 DESC, MAX(v.created_at) DESC, u.created_at DESC
       LIMIT 100`
    )
    .all(...params);

  res.render('athletes', { title: 'Find athletes', athletes, filters });
});

router.get('/athletes/:id', (req, res, next) => {
  const db = req.app.locals.db;
  const athlete = db
    .prepare(
      `SELECT u.id, u.name, u.email, p.*
       FROM users u LEFT JOIN athlete_profiles p ON p.user_id = u.id
       WHERE u.id = ? AND u.role = 'athlete'`
    )
    .get(req.params.id);
  if (!athlete) return next();

  const videos = db
    .prepare('SELECT * FROM videos WHERE athlete_id = ? ORDER BY game_date DESC, created_at DESC, id DESC')
    .all(athlete.id);

  const isOwner = req.user && req.user.id === athlete.id;
  let visitRequests = [];
  let canSeeContact = isOwner;
  if (req.user && req.user.role === 'coach') {
    visitRequests = db
      .prepare('SELECT * FROM visit_requests WHERE coach_id = ? AND athlete_id = ? ORDER BY created_at DESC, id DESC')
      .all(req.user.id, athlete.id);
    canSeeContact = visitRequests.some((r) => r.status === 'accepted');
  }
  const hasPending = visitRequests.some((r) => r.status === 'pending');

  res.render('athlete-show', {
    title: athlete.name,
    athlete,
    videos,
    isOwner,
    canSeeContact,
    visitRequests,
    hasPending,
    preselectVideo: req.query.video || '',
  });
});

module.exports = router;
