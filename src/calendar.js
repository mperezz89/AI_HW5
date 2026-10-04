// Visit calendar helpers. Slot times are naive campus-local "YYYY-MM-DDTHH:MM" strings, so they
// are formatted as UTC to keep the server's own time zone out of the picture.

const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function nowLocal(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocal(value) {
  return new Date(`${value}:00Z`);
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

function formatDay(startsAt) {
  return parseLocal(startsAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatTimeRange(startsAt, minutes) {
  const start = parseLocal(startsAt);
  return `${formatTime(start)} – ${formatTime(new Date(start.getTime() + minutes * 60000))}`;
}

function formatSlot(startsAt, minutes) {
  const day = parseLocal(startsAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${day} · ${formatTimeRange(startsAt, minutes)}`;
}

function isValidLocal(value) {
  return typeof value === 'string' && DATETIME_LOCAL.test(value) && !Number.isNaN(parseLocal(value).getTime());
}

// A coach's upcoming slots with how many athletes have booked each.
function upcomingSlots(db, coachId, { openOnly = false } = {}) {
  return db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM visit_requests r WHERE r.slot_id = s.id AND r.status = 'accepted') AS booked
       FROM visit_slots s
       WHERE s.coach_id = ? AND s.starts_at > ?
       ${openOnly ? "AND (SELECT COUNT(*) FROM visit_requests r WHERE r.slot_id = s.id AND r.status = 'accepted') < s.capacity" : ''}
       ORDER BY s.starts_at`
    )
    .all(coachId, nowLocal());
}

// Groups slots by calendar day for display: [{ day, slots }].
function groupByDay(slots) {
  const days = [];
  for (const slot of slots) {
    const day = formatDay(slot.starts_at);
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, slots: [] });
    days[days.length - 1].slots.push(slot);
  }
  return days;
}

module.exports = { nowLocal, isValidLocal, formatSlot, formatTimeRange, upcomingSlots, groupByDay };
