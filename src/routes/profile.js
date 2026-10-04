const express = require('express');
const { requireAuth } = require('../auth');
const { resolveTeam } = require('../db');
const { COACH_TITLES } = require('../constants');

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
const COACH_FIELDS = ['title', 'school', 'sport', 'division'];
const MAX_TEAM_CODE_LENGTH = 40;

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
    : db
        .prepare('SELECT c.*, t.team_code FROM coach_profiles c LEFT JOIN teams t ON t.id = c.team_id WHERE c.user_id = ?')
        .get(user.id);
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

  let team = null;
  if (isAthlete) {
    const error = validateAthlete(db, req.user.id, profile);
    if (error) return res.status(400).render('profile-edit', { title: 'Edit profile', profile, error });
  } else {
    profile.team_code = (req.body.team_code || '').trim() || null;
    let error = null;
    if (profile.title && !COACH_TITLES.includes(profile.title)) error = 'Choose Coach, Recruiter, or Assistant as your title.';
    else if (profile.sport && !req.app.locals.SPORTS.includes(profile.sport)) error = 'Choose a team sport from the list.';
    else if (profile.team_code && profile.team_code.length > MAX_TEAM_CODE_LENGTH) error = 'Team ID is too long.';
    else if (profile.team_code && !(profile.school && profile.sport)) error = 'Add your team name and team sport along with your Team ID.';
    else if (profile.school && profile.sport) ({ team, error } = resolveTeam(db, req.user.id, profile));
    if (error) return res.status(400).render('profile-edit', { title: 'Edit profile', profile, error });
    // A Team ID joins an existing team, so use that team's name.
    if (team) profile.school = team.school;
  }

  const name = (req.body.name || '').trim();
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);

  const table = isAthlete ? 'athlete_profiles' : 'coach_profiles';
  const assignments = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE user_id = ?`).run(...fields.map((f) => profile[f]), req.user.id);

  if (!isAthlete) {
    db.prepare('UPDATE coach_profiles SET team_id = ? WHERE user_id = ?').run(team ? team.id : null, req.user.id);
  }

  const typedName = (req.body.school || '').trim();
  req.session.flash =
    team && typedName.toLowerCase() !== team.school.toLowerCase()
      ? `Profile saved. Team ID ${team.team_code} is registered to ${team.school}, so you've joined that team.`
      : 'Profile saved.';
  res.redirect(isAthlete ? `/athletes/${req.user.id}` : `/coaches/${req.user.id}`);
});

module.exports = router;
