const express = require('express');
const { requireAuth } = require('../auth');

const router = express.Router();

const ATHLETE_FIELDS = ['sport', 'position', 'grad_year', 'high_school', 'city', 'state', 'height', 'weight', 'gpa', 'bio', 'phone'];
const COACH_FIELDS = ['school', 'title', 'sport', 'division'];

function loadProfile(db, user) {
  return user.role === 'athlete'
    ? db.prepare('SELECT * FROM athlete_profiles WHERE user_id = ?').get(user.id)
    : db.prepare('SELECT * FROM coach_profiles WHERE user_id = ?').get(user.id);
}

router.get('/profile/edit', requireAuth, (req, res) => {
  const profile = loadProfile(req.app.locals.db, req.user) || {};
  res.render('profile-edit', { title: 'Edit profile', profile, error: null });
});

router.post('/profile/edit', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const isAthlete = req.user.role === 'athlete';
  const fields = isAthlete ? ATHLETE_FIELDS : COACH_FIELDS;
  const values = fields.map((f) => {
    const v = (req.body[f] || '').trim();
    return v === '' ? null : v;
  });

  if (isAthlete) {
    const gradIdx = fields.indexOf('grad_year');
    if (values[gradIdx] !== null) {
      const year = Number(values[gradIdx]);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        const profile = Object.fromEntries(fields.map((f, i) => [f, values[i]]));
        return res.status(400).render('profile-edit', { title: 'Edit profile', profile, error: 'Graduation year must be a 4-digit year.' });
      }
      values[gradIdx] = year;
    }
  }

  const name = (req.body.name || '').trim();
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);

  const table = isAthlete ? 'athlete_profiles' : 'coach_profiles';
  const assignments = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE user_id = ?`).run(...values, req.user.id);

  req.session.flash = 'Profile saved.';
  res.redirect(isAthlete ? `/athletes/${req.user.id}` : '/dashboard');
});

module.exports = router;
