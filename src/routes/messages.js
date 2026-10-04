const express = require('express');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 5000;

// SQL condition (on alias `c`) for conversations this user can read: an athlete sees their own,
// a coach sees ones addressed to them or to their team's shared inbox.
function accessClause(user) {
  return user.role === 'athlete'
    ? { sql: 'c.athlete_id = ?', params: [user.id] }
    : { sql: '(c.coach_id = ? OR c.team_id = (SELECT team_id FROM coach_profiles WHERE user_id = ?))', params: [user.id, user.id] };
}

function unreadCount(db, user) {
  const access = accessClause(user);
  return db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = ?
       WHERE ${access.sql} AND m.sender_id != ? AND m.id > COALESCE(r.last_read_message_id, 0)`
    )
    .get(user.id, ...access.params, user.id).n;
}

const CONVERSATION_COLUMNS = `
  c.*, a.name AS athlete_name, co.name AS coach_name, cp.title AS coach_title,
  COALESCE(t.school, ct.school) AS school, COALESCE(t.sport, ct.sport) AS sport`;
const CONVERSATION_JOINS = `
  JOIN users a ON a.id = c.athlete_id
  LEFT JOIN users co ON co.id = c.coach_id
  LEFT JOIN coach_profiles cp ON cp.user_id = c.coach_id
  LEFT JOIN teams ct ON ct.id = cp.team_id
  LEFT JOIN teams t ON t.id = c.team_id`;

function findConversation(db, user, id) {
  const access = accessClause(user);
  return db
    .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c ${CONVERSATION_JOINS} WHERE c.id = ? AND ${access.sql}`)
    .get(Number(id), ...access.params);
}

function addMessage(db, conversationId, senderId, body) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
    .run(conversationId, senderId, body);
  markRead(db, conversationId, senderId, Number(lastInsertRowid));
}

function markRead(db, conversationId, userId, messageId) {
  db.prepare(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`
  ).run(conversationId, userId, messageId);
}

function cleanBody(body) {
  const text = (body || '').trim();
  if (!text) return { error: 'Write a message first.' };
  if (text.length > MAX_MESSAGE_LENGTH) return { error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.` };
  return { text };
}

// Who a new message from an athlete is addressed to: one coach, or a team's shared inbox.
function findRecipient(db, { coach, team }) {
  if (coach) {
    const c = db
      .prepare(
        `SELECT u.id, u.name, cp.title, t.school, t.sport FROM users u
         LEFT JOIN coach_profiles cp ON cp.user_id = u.id LEFT JOIN teams t ON t.id = cp.team_id
         WHERE u.id = ? AND u.role = 'coach'`
      )
      .get(Number(coach));
    return c && { kind: 'coach', id: c.id, label: c.name, detail: [c.title, c.school].filter(Boolean).join(', ') };
  }
  if (team) {
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(team));
    return t && { kind: 'team', id: t.id, label: t.school, detail: `${t.sport} coaching staff` };
  }
  return null;
}

function existingConversation(db, athleteId, recipient) {
  const column = recipient.kind === 'coach' ? 'coach_id' : 'team_id';
  return db.prepare(`SELECT id FROM conversations WHERE athlete_id = ? AND ${column} = ?`).get(athleteId, recipient.id);
}

router.get('/messages', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const access = accessClause(req.user);
  const conversations = db
    .prepare(
      `SELECT ${CONVERSATION_COLUMNS},
              lm.body AS last_body, lm.created_at AS last_at, lm.sender_id AS last_sender_id,
              (SELECT COUNT(*) FROM messages m
               WHERE m.conversation_id = c.id AND m.sender_id != ?
                 AND m.id > COALESCE((SELECT last_read_message_id FROM conversation_reads r
                                      WHERE r.conversation_id = c.id AND r.user_id = ?), 0)) AS unread
       FROM conversations c ${CONVERSATION_JOINS}
       JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
       WHERE ${access.sql}
       ORDER BY lm.id DESC`
    )
    .all(req.user.id, req.user.id, ...access.params);
  res.render('messages', { title: 'Messages', conversations });
});

router.get('/messages/new', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const recipient = findRecipient(db, req.query);
  if (!recipient) return next();
  const existing = existingConversation(db, req.user.id, recipient);
  if (existing) return res.redirect(`/messages/${existing.id}`);
  res.render('message-new', { title: 'New message', recipient, error: null, body: '' });
});

router.post('/messages', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const recipient = findRecipient(db, req.body);
  if (!recipient) return next();
  const { text, error } = cleanBody(req.body.body);
  if (error) return res.status(400).render('message-new', { title: 'New message', recipient, error, body: req.body.body || '' });

  let conversation = existingConversation(db, req.user.id, recipient);
  if (!conversation) {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO conversations (athlete_id, ${recipient.kind === 'coach' ? 'coach_id' : 'team_id'}) VALUES (?, ?)`)
      .run(req.user.id, recipient.id);
    conversation = { id: Number(lastInsertRowid) };
  }
  addMessage(db, conversation.id, req.user.id, text);
  res.redirect(`/messages/${conversation.id}#latest`);
});

router.get('/messages/:id', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const conversation = findConversation(db, req.user, req.params.id);
  if (!conversation) return next();
  const messages = db
    .prepare(
      `SELECT m.*, u.name AS sender_name, u.role AS sender_role
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ORDER BY m.id`
    )
    .all(conversation.id);
  if (messages.length) markRead(db, conversation.id, req.user.id, messages[messages.length - 1].id);
  res.locals.unreadMessages = unreadCount(db, req.user);
  res.render('conversation', { title: 'Messages', conversation, messages, error: null });
});

router.post('/messages/:id', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const conversation = findConversation(db, req.user, req.params.id);
  if (!conversation) return next();
  const { text, error } = cleanBody(req.body.body);
  if (error) {
    req.session.flash = error;
    return res.redirect(`/messages/${conversation.id}`);
  }
  addMessage(db, conversation.id, req.user.id, text);
  res.redirect(`/messages/${conversation.id}#latest`);
});

module.exports = router;
module.exports.unreadCount = unreadCount;
