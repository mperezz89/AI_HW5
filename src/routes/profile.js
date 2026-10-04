const express = require('express');
const { requireAuth } = require('../auth');
const { findOrCreateTeam } = require('../db');

const router = express.Router();

const ATHLETE_FIELDS = [
  'athlete_code',
  'sport',
  'high_school',
  'position',
  'position_rank',
  'star_rating',
  'national_rank',
  'city',
  'state',
  'bio',
  'grad_year',
  'height',
  'weight',
  'gpa',
  'phone',
];
const COACH_FIELDS = ['school', 'title', 'sport', 'division'];

// Whole-number athlete fields and their allowed ranges.
const ATHLETE_INTEGER_FIELDS = {
  position_rank: { min: 1, max: 100000, message: 'Position ranking must be a whole number of 1 or more.' },
  star_rating: { min: 1, max: 5, message: 'Star ranking must be between 1 and 5 stars.' },
  national_rank: { min: 1, max: 100000, message: 'National ranking must be a whole number of 1 or more.' },
  grad_year: { min: 2000, max: 2100, message: 'Graduation year must be a 4-digit year.' },
};

function loadProfile(db, user) {
  return user.role === 'athlete'
    ? db.prepare('SELECT * FROM athlete_profiles WHERE user_id = ?').get(user.id)
    : db.prepare('SELECT * FROM coach_profiles WHERE user_id = ?').get(user.id);
}

function validateAthlete(db, userId, profile) {
  for (const [field, { min, max, message }] of Object.entries(ATHLETE_INTEGER_FIELDS)) {
    if (profile[field] === null) continue;
    const n = Number(String(profile[field]).replace(/^#/, ''));
    if (!Number.isInteger(n) || n < min || n > max) return message;
    profile[field] = n;
  }
  if (profile.athlete_code) {
    const taken = db
      .prepare('SELECT 1 FROM athlete_profiles WHERE athlete_code = ? COLLATE NOCASE AND user_id != ?')
      .get(profile.athlete_code, userId);
    if (taken) return 'That Athlete ID is already in use by another athlete.';
  }
  return null;
}

router.get('/profile/edit', requireAuth, (req, res) => {
  const profile = loadProfile(req.app.locals.db, req.user) || {};
  res.render('profile-edit', { title: 'Edit profile', profile, error: null });
});

router.post('/profile/edit', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const isAthlete = req.user.role === 'athlete';
  const fields = isAthlete ? ATHLETE_FIELDS : COACH_FIELDS;
  const profile = Object.fromEntries(
    fields.map((f) => {
      const v = (req.body[f] || '').trim();
      return [f, v === '' ? null : v];
    })
  );

  if (isAthlete) {
    const error = validateAthlete(db, req.user.id, profile);
    if (error) return res.status(400).render('profile-edit', { title: 'Edit profile', profile, error });
  }

  const name = (req.body.name || '').trim();
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);

  const table = isAthlete ? 'athlete_profiles' : 'coach_profiles';
  const assignments = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE user_id = ?`).run(...fields.map((f) => profile[f]), req.user.id);

  if (!isAthlete) {
    const teamId = profile.school && profile.sport ? findOrCreateTeam(db, profile) : null;
    db.prepare('UPDATE coach_profiles SET team_id = ? WHERE user_id = ?').run(teamId, req.user.id);
  }

  req.session.flash = 'Profile saved.';
  res.redirect(isAthlete ? `/athletes/${req.user.id}` : '/dashboard');
});

module.exports = router;
