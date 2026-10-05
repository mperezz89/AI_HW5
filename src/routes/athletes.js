const express = require('express');
const { requireAuth } = require('../auth');
const { missingPreferredFields } = require('../constants');
const { followStats } = require('./people');
const { myTeam } = require('./staff');
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
  let team = null;
  let recruit = null;
  let staffVisits = [];
  if (req.user && req.user.role === 'coach') {
    visitRequests = db
      .prepare(
        `SELECT r.*, s.starts_at, s.duration_minutes FROM visit_requests r LEFT JOIN visit_slots s ON s.id = r.slot_id
         WHERE r.coach_id = ? AND r.athlete_id = ? ORDER BY r.created_at DESC, r.id DESC`
      )
      .all(req.user.id, athlete.id);
    coachOpenTimes = upcomingSlots(db, req.user.id, { openOnly: true }).length;
    team = myTeam(db, req.user.id);
    if (team) {
      recruit = db
        .prepare(
          `SELECT r.*, u.name AS updated_by_name FROM recruits r LEFT JOIN users u ON u.id = r.updated_by
           WHERE r.team_id = ? AND r.athlete_id = ?`
        )
        .get(team.id, athlete.id);
      staffVisits = db
        .prepare(
          `SELECT r.*, c.name AS coach_name, s.starts_at, s.duration_minutes
           FROM visit_requests r JOIN coach_profiles cp ON cp.user_id = r.coach_id JOIN users c ON c.id = r.coach_id
           LEFT JOIN visit_slots s ON s.id = r.slot_id
           WHERE cp.team_id = ? AND r.athlete_id = ? AND r.coach_id != ?
           ORDER BY r.created_at DESC`
        )
        .all(team.id, athlete.id, req.user.id);
    }
    // Contact info is shared with the whole staff once the athlete schedules a visit with any of them.
    canSeeContact = [...visitRequests, ...staffVisits].some((r) => r.status === 'accepted');
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
    team,
    recruit,
    staffVisits,
    coachOpenTimes,
    preselectVideo: req.query.video || '',
    missing: isOwner ? missingPreferredFields(athlete) : [],
    social: followStats(db, athlete.id, req.user && req.user.id),
  });
});

module.exports = router;
