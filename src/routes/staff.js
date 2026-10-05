const express = require('express');
const { requireRole } = require('../auth');
const { joinTeam } = require('../db');
const { COACH_TITLES } = require('../constants');
const { nowLocal } = require('../calendar');

const router = express.Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NOTES_LENGTH = 2000;

function myTeam(db, userId) {
  return db.prepare('SELECT t.* FROM coach_profiles c JOIN teams t ON t.id = c.team_id WHERE c.user_id = ?').get(userId);
}

// Loads the team in the URL, only for coaches on its staff.
function staffTeam(req, res, next) {
  const team = myTeam(req.app.locals.db, req.user.id);
  if (!team || String(team.id) !== req.params.id) {
    return res.status(403).render('error', { title: 'Not allowed', message: 'Only members of this coaching staff can do that.' });
  }
  req.team = team;
  next();
}

// Loads the coach's own team, or sends them to set one up.
function requireTeam(req, res, next) {
  req.team = myTeam(req.app.locals.db, req.user.id);
  if (req.team) return next();
  req.session.flash = 'Set up your team on your coach profile first, or ask your staff to add you.';
  res.redirect('/profile/edit');
}

function renderStaff(req, res, { status = 200, error = null, form = {} } = {}) {
  const db = req.app.locals.db;
  const staff = db
    .prepare(
      `SELECT u.id, u.name, u.email, c.title,
              (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id AND p.team_id = c.team_id) AS posts
       FROM coach_profiles c JOIN users u ON u.id = c.user_id
       WHERE c.team_id = ? ORDER BY u.name`
    )
    .all(req.team.id);
  const invites = db
    .prepare(
      `SELECT i.*, u.name AS invited_by_name FROM team_invites i LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.team_id = ? ORDER BY i.created_at DESC`
    )
    .all(req.team.id);
  res.status(status).render('team-staff', { title: 'Coaching staff', team: req.team, staff, invites, error, form });
}

router.get('/teams/:id/staff', requireRole('coach'), staffTeam, (req, res) => renderStaff(req, res));

// Add a coach or recruiter by email: an existing coach account joins now; anyone else joins when they sign up.
router.post('/teams/:id/staff', requireRole('coach'), staffTeam, (req, res) => {
  const db = req.app.locals.db;
  const form = { email: (req.body.email || '').trim().toLowerCase(), title: req.body.title || 'Recruiter' };
  const fail = (error) => renderStaff(req, res, { status: 400, error, form });
  if (!EMAIL.test(form.email)) return fail('Enter a valid email address.');
  if (!COACH_TITLES.includes(form.title)) return fail('Choose Coach, Recruiter, or Assistant.');

  const user = db
    .prepare('SELECT u.id, u.name, u.role, c.team_id FROM users u LEFT JOIN coach_profiles c ON c.user_id = u.id WHERE u.email = ?')
    .get(form.email);
  if (user) {
    if (user.role !== 'coach') return fail(`${form.email} belongs to an athlete account. Only coaches can join a staff.`);
    if (user.team_id === req.team.id) return fail(`${user.name} is already on your staff.`);
    if (user.team_id) return fail(`${user.name} is on another team's staff. They need to leave that team first.`);
    joinTeam(db, user.id, req.team, form.title);
    req.session.flash = `${user.name} has joined your staff.`;
    return res.redirect(`/teams/${req.team.id}/staff`);
  }

  db.prepare(
    `INSERT INTO team_invites (team_id, email, title, invited_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (team_id, email) DO UPDATE SET title = excluded.title, invited_by = excluded.invited_by`
  ).run(req.team.id, form.email, form.title, req.user.id);
  req.session.flash = `${form.email} doesn't have an account yet. They'll join your staff when they sign up as a coach with that email.`;
  res.redirect(`/teams/${req.team.id}/staff`);
});

// Remove a staff member, or leave the team yourself.
router.post('/teams/:id/staff/:userId/remove', requireRole('coach'), staffTeam, (req, res, next) => {
  const db = req.app.locals.db;
  const member = db
    .prepare('SELECT u.id, u.name FROM coach_profiles c JOIN users u ON u.id = c.user_id WHERE c.user_id = ? AND c.team_id = ?')
    .get(req.params.userId, req.team.id);
  if (!member) return next();
  db.prepare('UPDATE coach_profiles SET team_id = NULL WHERE user_id = ?').run(member.id);
  if (member.id === req.user.id) {
    req.session.flash = `You left the ${req.team.school} ${req.team.sport} staff.`;
    return res.redirect('/dashboard');
  }
  req.session.flash = `${member.name} was removed from your staff.`;
  res.redirect(`/teams/${req.team.id}/staff`);
});

router.post('/teams/:id/invites/:inviteId/cancel', requireRole('coach'), staffTeam, (req, res) => {
  req.app.locals.db.prepare('DELETE FROM team_invites WHERE id = ? AND team_id = ?').run(req.params.inviteId, req.team.id);
  req.session.flash = 'Invite cancelled.';
  res.redirect(`/teams/${req.team.id}/staff`);
});

// The team's shared recruiting board, plus every staff member's visit invitations.
router.get('/recruiting', requireRole('coach'), requireTeam, (req, res) => {
  const db = req.app.locals.db;
  const recruits = db
    .prepare(
      `SELECT r.*, u.name, a.athlete_code, a.sport, a.position, a.high_school, a.city, a.state, a.star_rating,
              a.national_rank, a.grad_year, ab.name AS added_by_name, ub.name AS updated_by_name,
              (SELECT COUNT(*) FROM videos v WHERE v.athlete_id = r.athlete_id) AS video_count
       FROM recruits r
       JOIN users u ON u.id = r.athlete_id
       LEFT JOIN athlete_profiles a ON a.user_id = r.athlete_id
       LEFT JOIN users ab ON ab.id = r.added_by
       LEFT JOIN users ub ON ub.id = r.updated_by
       WHERE r.team_id = ?
       ORDER BY a.national_rank IS NULL, a.national_rank, r.created_at DESC`
    )
    .all(req.team.id);
  const visits = db
    .prepare(
      `SELECT v.*, a.name AS athlete_name, ap.athlete_code, c.name AS coach_name, s.starts_at, s.duration_minutes
       FROM visit_requests v
       JOIN coach_profiles cp ON cp.user_id = v.coach_id
       JOIN users a ON a.id = v.athlete_id
       LEFT JOIN athlete_profiles ap ON ap.user_id = v.athlete_id
       JOIN users c ON c.id = v.coach_id
       LEFT JOIN visit_slots s ON s.id = v.slot_id
       WHERE cp.team_id = ?
       ORDER BY v.status = 'accepted' AND s.starts_at > ? DESC, v.status = 'pending' DESC, s.starts_at, v.created_at DESC`
    )
    .all(req.team.id, nowLocal());
  res.render('recruiting', { title: 'Recruiting board', team: req.team, recruits, visits, error: null, form: {} });
});

// Add an athlete to the board by Athlete ID (from the board) or by account (from their profile).
router.post('/recruiting', requireRole('coach'), requireTeam, (req, res) => {
  const db = req.app.locals.db;
  const code = (req.body.athlete_code || '').trim();
  const notes = (req.body.notes || '').trim().slice(0, MAX_NOTES_LENGTH) || null;
  const athlete = req.body.athlete_id
    ? db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'athlete'").get(Number(req.body.athlete_id))
    : db
        .prepare('SELECT u.id, u.name FROM athlete_profiles a JOIN users u ON u.id = a.user_id WHERE a.athlete_code = ? COLLATE NOCASE')
        .get(code);
  const back = req.body.athlete_id ? `/athletes/${req.body.athlete_id}` : '/recruiting';
  if (!athlete) {
    req.session.flash = code ? `No athlete has the Athlete ID ${code}.` : 'Enter an Athlete ID.';
    return res.redirect(back);
  }
  const added = db
    .prepare(
      `INSERT INTO recruits (team_id, athlete_id, added_by, notes, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (team_id, athlete_id) DO NOTHING`
    )
    .run(req.team.id, athlete.id, req.user.id, notes, req.user.id);
  req.session.flash = added.changes
    ? `${athlete.name} is on your team's recruiting board.`
    : `${athlete.name} is already on your team's recruiting board.`;
  res.redirect(back);
});

router.post('/recruiting/:athleteId/notes', requireRole('coach'), requireTeam, (req, res, next) => {
  const db = req.app.locals.db;
  const notes = (req.body.notes || '').trim().slice(0, MAX_NOTES_LENGTH) || null;
  const updated = db
    .prepare("UPDATE recruits SET notes = ?, updated_by = ?, updated_at = datetime('now') WHERE team_id = ? AND athlete_id = ?")
    .run(notes, req.user.id, req.team.id, Number(req.params.athleteId));
  if (!updated.changes) return next();
  req.session.flash = 'Notes saved for your staff.';
  res.redirect(req.body.back === 'profile' ? `/athletes/${req.params.athleteId}` : `/recruiting#recruit-${req.params.athleteId}`);
});

router.post('/recruiting/:athleteId/remove', requireRole('coach'), requireTeam, (req, res) => {
  req.app.locals.db
    .prepare('DELETE FROM recruits WHERE team_id = ? AND athlete_id = ?')
    .run(req.team.id, Number(req.params.athleteId));
  req.session.flash = 'Removed from your recruiting board.';
  res.redirect('/recruiting');
});

module.exports = router;
module.exports.myTeam = myTeam;
