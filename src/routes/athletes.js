const express = require('express');
const { requireAuth } = require('../auth');
const { missingPreferredFields } = require('../constants');
const { followStats } = require('./people');
const { nowLocal, upcomingSlots } = require('../calendar');

const router = express.Router();

router.get('/athletes', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const filters = {
    q: (req.query.q || '').trim(),
    sport: req.query.sport || '',
    position: (req.query.position || '').trim(),
    grad_year: req.query.grad_year || '',
    state: req.query.state || '',
    min_stars: req.query.min_stars || '',
    sort: req.query.sort === 'national_rank' ? 'national_rank' : 'recent',
  };

  const where = ["u.role = 'athlete'"];
  const params = [];
  if (filters.q) {
    where.push('(u.name LIKE ? OR p.high_school LIKE ? OR p.city LIKE ? OR p.athlete_code LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
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
  if (filters.min_stars) {
    where.push('p.star_rating >= ?');
    params.push(Number(filters.min_stars));
  }

  const orderBy =
    filters.sort === 'national_rank'
      ? 'p.national_rank IS NULL, p.national_rank, u.name'
      : 'video_count > 0 DESC, MAX(v.created_at) DESC, u.created_at DESC';

  const athletes = db
    .prepare(
      `SELECT u.id, u.name, p.sport, p.position, p.grad_year, p.high_school, p.city, p.state,
              p.athlete_code, p.position_rank, p.star_rating, p.national_rank,
              COUNT(v.id) AS video_count, COALESCE(SUM(v.views), 0) AS total_views,
              (SELECT filename FROM videos WHERE athlete_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_filename,
              (SELECT mime_type FROM videos WHERE athlete_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_mime
       FROM users u
       LEFT JOIN athlete_profiles p ON p.user_id = u.id
       LEFT JOIN videos v ON v.athlete_id = u.id
       WHERE ${where.join(' AND ')}
       GROUP BY u.id
       ORDER BY ${orderBy}
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
  let coachOpenTimes = 0;
  if (req.user && req.user.role === 'coach') {
    visitRequests = db
      .prepare(
        `SELECT r.*, s.starts_at, s.duration_minutes FROM visit_requests r LEFT JOIN visit_slots s ON s.id = r.slot_id
         WHERE r.coach_id = ? AND r.athlete_id = ? ORDER BY r.created_at DESC, r.id DESC`
      )
      .all(req.user.id, athlete.id);
    canSeeContact = visitRequests.some((r) => r.status === 'accepted');
    coachOpenTimes = upcomingSlots(db, req.user.id, { openOnly: true }).length;
  }
  const now = nowLocal();
  const hasOpenInvite = visitRequests.some(
    (r) => r.status === 'pending' || (r.status === 'accepted' && r.starts_at && r.starts_at > now)
  );

  res.render('athlete-show', {
    title: athlete.name,
    athlete,
    videos,
    isOwner,
    canSeeContact,
    visitRequests,
    hasOpenInvite,
    coachOpenTimes,
    preselectVideo: req.query.video || '',
    missing: isOwner ? missingPreferredFields(athlete) : [],
    social: followStats(db, athlete.id, req.user && req.user.id),
  });
});

module.exports = router;
