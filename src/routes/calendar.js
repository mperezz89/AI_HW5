const express = require('express');
const { requireRole } = require('../auth');
const { nowLocal, isValidLocal, upcomingSlots, groupByDay } = require('../calendar');

const router = express.Router();

function localPath(p, fallback) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : fallback;
}

function renderCalendar(req, res, { status = 200, error = null, form = {}, access: accessForm = {} } = {}) {
  const db = req.app.locals.db;
  const slots = upcomingSlots(db, req.user.id);
  const bookings = db
    .prepare(
      `SELECT r.slot_id, u.id AS athlete_id, u.name AS athlete_name
       FROM visit_requests r JOIN users u ON u.id = r.athlete_id
       WHERE r.coach_id = ? AND r.status = 'accepted' AND r.slot_id IS NOT NULL`
    )
    .all(req.user.id);
  for (const slot of slots) slot.athletes = bookings.filter((b) => b.slot_id === slot.id);
  // Athletes this coach has opened the calendar to: waiting to pick a time, or booked for an upcoming visit.
  const access = db
    .prepare(
      `SELECT r.id, r.status, r.created_at, u.id AS athlete_id, u.name, a.athlete_code, a.sport, a.position,
              s.starts_at, s.duration_minutes
       FROM visit_requests r
       JOIN users u ON u.id = r.athlete_id
       LEFT JOIN athlete_profiles a ON a.user_id = r.athlete_id
       LEFT JOIN visit_slots s ON s.id = r.slot_id
       WHERE r.coach_id = ? AND (r.status = 'pending' OR (r.status = 'accepted' AND s.starts_at > ?))
       ORDER BY r.status = 'pending' DESC, r.created_at DESC`
    )
    .all(req.user.id, nowLocal());
  const accessFormValues = { athlete_code: req.query.athlete_id || '', message: '', ...accessForm };
  res.status(status).render('calendar', {
    title: 'Visit calendar',
    days: groupByDay(slots),
    access,
    error,
    form,
    accessError: accessForm.error || null,
    accessForm: accessFormValues,
    minStart: nowLocal(),
  });
}

router.get('/calendar', requireRole('coach'), (req, res) => renderCalendar(req, res));

router.post('/calendar/slots', requireRole('coach'), (req, res) => {
  const form = {
    starts_at: (req.body.starts_at || '').trim(),
    duration_minutes: req.body.duration_minutes || '120',
    capacity: req.body.capacity || '1',
    location: (req.body.location || '').trim(),
  };
  const duration = Number(form.duration_minutes);
  const capacity = Number(form.capacity);

  let error = null;
  if (!isValidLocal(form.starts_at)) error = 'Choose a date and start time.';
  else if (form.starts_at <= nowLocal()) error = 'Visit times must be in the future.';
  else if (!Number.isInteger(duration) || duration < 15 || duration > 720) error = 'Length must be between 15 minutes and 12 hours.';
  else if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) error = 'Athletes per time must be between 1 and 50.';
  else if (form.location.length > 300) error = 'Location and notes can be up to 300 characters.';
  if (error) return renderCalendar(req, res, { status: 400, error, form });

  req.app.locals.db
    .prepare('INSERT INTO visit_slots (coach_id, starts_at, duration_minutes, capacity, location) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, form.starts_at, duration, capacity, form.location || null);
  req.session.flash = 'Visit time added to your calendar.';
  res.redirect('/calendar');
});

router.post('/calendar/slots/:id/delete', requireRole('coach'), (req, res, next) => {
  const db = req.app.locals.db;
  const slot = db.prepare('SELECT id FROM visit_slots WHERE id = ? AND coach_id = ?').get(req.params.id, req.user.id);
  if (!slot) return next();
  const booked = db.prepare("SELECT 1 FROM visit_requests WHERE slot_id = ? AND status = 'accepted'").get(slot.id);
  if (booked) {
    req.session.flash = 'That time has booked visits. Message the athletes before changing it.';
    return res.redirect('/calendar');
  }
  db.prepare('DELETE FROM visit_slots WHERE id = ?').run(slot.id);
  req.session.flash = 'Visit time removed.';
  res.redirect('/calendar');
});

// Coaches open their calendar to one athlete at a time by Athlete ID. The calendar is never public:
// only athletes with an open invitation (a visit request) can see and book its times.
router.post('/calendar/access', requireRole('coach'), (req, res) => {
  const db = req.app.locals.db;
  const code = (req.body.athlete_code || '').trim();
  const message = (req.body.message || '').trim();
  const fromProfile = localPath(req.body.back, null);
  const fail = (error) => {
    if (fromProfile) {
      req.session.flash = error;
      return res.redirect(fromProfile);
    }
    return renderCalendar(req, res, { status: 400, access: { athlete_code: code, message, error } });
  };

  if (!code) return fail('Enter the Athlete ID of the athlete you want to invite.');
  const athlete = db
    .prepare(
      `SELECT u.id, u.name, a.athlete_code FROM athlete_profiles a JOIN users u ON u.id = a.user_id
       WHERE a.athlete_code = ? COLLATE NOCASE`
    )
    .get(code);
  if (!athlete) return fail(`No athlete has the Athlete ID ${code}. Check the ID with the athlete.`);
  if (!message) return fail('Include a message so the athlete knows why you are inviting them.');

  const open = db
    .prepare(
      `SELECT 1 FROM visit_requests r LEFT JOIN visit_slots s ON s.id = r.slot_id
       WHERE r.coach_id = ? AND r.athlete_id = ?
         AND (r.status = 'pending' OR (r.status = 'accepted' AND s.starts_at > ?))`
    )
    .get(req.user.id, athlete.id, nowLocal());
  if (open) return fail(`Your calendar is already open to ${athlete.name}.`);

  let videoId = req.body.video_id ? Number(req.body.video_id) : null;
  if (videoId && !db.prepare('SELECT 1 FROM videos WHERE id = ? AND athlete_id = ?').get(videoId, athlete.id)) videoId = null;

  db.prepare('INSERT INTO visit_requests (coach_id, athlete_id, video_id, message) VALUES (?, ?, ?, ?)').run(
    req.user.id,
    athlete.id,
    videoId,
    message
  );
  req.session.flash = `Your visit calendar is now open to ${athlete.name} (${athlete.athlete_code}). They can pick a time to visit.`;
  res.redirect(fromProfile || '/calendar');
});

// Withdraw access before the athlete books; booked visits are handled by messaging the athlete.
router.post('/calendar/access/:id/withdraw', requireRole('coach'), (req, res, next) => {
  const db = req.app.locals.db;
  const request = db
    .prepare("SELECT r.id, u.name FROM visit_requests r JOIN users u ON u.id = r.athlete_id WHERE r.id = ? AND r.coach_id = ? AND r.status = 'pending'")
    .get(req.params.id, req.user.id);
  if (!request) return next();
  db.prepare('DELETE FROM visit_requests WHERE id = ?').run(request.id);
  req.session.flash = `${request.name} no longer has access to your calendar.`;
  res.redirect('/calendar');
});

function athleteRequest(db, req) {
  return db
    .prepare(
      `SELECT r.*, u.name AS coach_name, c.title AS coach_title, c.school, s.starts_at, s.duration_minutes, s.location
       FROM visit_requests r
       JOIN users u ON u.id = r.coach_id
       LEFT JOIN coach_profiles c ON c.user_id = r.coach_id
       LEFT JOIN visit_slots s ON s.id = r.slot_id
       WHERE r.id = ? AND r.athlete_id = ?`
    )
    .get(req.params.id, req.user.id);
}

// An invitation opens the coach's calendar to this athlete while it's pending or scheduled.
router.get('/visit-requests/:id/schedule', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const request = athleteRequest(db, req);
  if (!request) return next();
  if (request.status === 'declined') {
    req.session.flash = 'That invitation is closed.';
    return res.redirect('/dashboard');
  }
  const slots = upcomingSlots(db, request.coach_id, { openOnly: true }).filter((s) => s.id !== request.slot_id);
  res.render('visit-schedule', { title: 'Schedule a visit', request, days: groupByDay(slots) });
});

router.post('/visit-requests/:id/schedule', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const request = athleteRequest(db, req);
  if (!request) return next();
  const back = `/visit-requests/${request.id}/schedule`;
  if (request.status === 'declined') return res.redirect('/dashboard');

  const slot = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM visit_requests r WHERE r.slot_id = s.id AND r.status = 'accepted') AS booked
       FROM visit_slots s WHERE s.id = ? AND s.coach_id = ?`
    )
    .get(Number(req.body.slot_id), request.coach_id);
  if (!slot || slot.starts_at <= nowLocal() || slot.booked >= slot.capacity) {
    req.session.flash = 'That time is no longer available. Please choose another.';
    return res.redirect(back);
  }

  const note = (req.body.response_message || '').trim().slice(0, 1000) || request.response_message || null;
  db.prepare(
    "UPDATE visit_requests SET status = 'accepted', slot_id = ?, response_message = ?, responded_at = datetime('now') WHERE id = ?"
  ).run(slot.id, note, request.id);

  req.session.flash = request.slot_id
    ? 'Visit rescheduled.'
    : `Visit scheduled with ${request.coach_name}! ${request.school ? `The ${request.school} coaching staff` : 'They'} can now see your contact info.`;
  res.redirect('/dashboard');
});

router.post('/visit-requests/:id/cancel', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const request = athleteRequest(db, req);
  if (!request) return next();
  if (request.status === 'accepted') {
    db.prepare("UPDATE visit_requests SET status = 'pending', slot_id = NULL, responded_at = NULL WHERE id = ?").run(request.id);
    req.session.flash = 'Visit cancelled. The invitation is still open if you want to pick another time.';
  }
  res.redirect('/dashboard');
});

module.exports = router;
