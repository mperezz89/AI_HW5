const express = require('express');
const { requireAuth } = require('../auth');

const router = express.Router();

function localPath(p, fallback) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : fallback;
}

function profilePath(user) {
  return user.role === 'athlete' ? `/athletes/${user.id}` : `/coaches/${user.id}`;
}

// Follower/following counts for a user, and whether the viewer follows them.
// "Following" includes teams an athlete follows as well as people.
function followStats(db, userId, viewerId) {
  const followers = db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE followee_id = ?').get(userId).n;
  const following =
    db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE follower_id = ?').get(userId).n +
    db.prepare('SELECT COUNT(*) AS n FROM team_follows WHERE athlete_id = ?').get(userId).n;
  const isFollowing =
    !!viewerId && !!db.prepare('SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, userId);
  return { followers, following, isFollowing };
}

router.post('/people/:id/follow', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!target) return next();
  const back = localPath(req.body.back, profilePath(target));
  if (target.id === req.user.id) return res.redirect(back);

  const removed = db.prepare('DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target.id);
  if (!removed.changes) db.prepare('INSERT INTO user_follows (follower_id, followee_id) VALUES (?, ?)').run(req.user.id, target.id);
  res.redirect(back);
});

router.get('/coaches/:id', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const coach = db
    .prepare(
      `SELECT u.id, u.name, u.role, c.title, c.school, c.sport, c.division, c.team_id
       FROM users u LEFT JOIN coach_profiles c ON c.user_id = u.id
       WHERE u.id = ? AND u.role = 'coach'`
    )
    .get(req.params.id);
  if (!coach) return next();
  const posts = db
    .prepare('SELECT id, media_filename, media_kind, mime_type, caption FROM posts WHERE author_id = ? ORDER BY id DESC LIMIT 30')
    .all(coach.id);
  res.render('coach-show', {
    title: coach.name,
    coach,
    posts,
    social: followStats(db, coach.id, req.user.id),
    isSelf: req.user.id === coach.id,
  });
});

router.get('/people/:id/:list(followers|following)', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const person = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(req.params.id);
  if (!person) return next();
  const listingFollowers = req.params.list === 'followers';

  const people = db
    .prepare(
      `SELECT u.id, u.name, u.role,
              COALESCE(a.sport, c.sport) AS sport, a.position, a.high_school, c.school, c.title,
              EXISTS (SELECT 1 FROM user_follows x WHERE x.follower_id = ? AND x.followee_id = u.id) AS viewer_follows
       FROM user_follows f
       JOIN users u ON u.id = ${listingFollowers ? 'f.follower_id' : 'f.followee_id'}
       LEFT JOIN athlete_profiles a ON a.user_id = u.id
       LEFT JOIN coach_profiles c ON c.user_id = u.id
       WHERE ${listingFollowers ? 'f.followee_id' : 'f.follower_id'} = ?
       ORDER BY f.created_at DESC, u.name`
    )
    .all(req.user.id, person.id);
  const teams = listingFollowers
    ? []
    : db
        .prepare('SELECT t.* FROM team_follows f JOIN teams t ON t.id = f.team_id WHERE f.athlete_id = ? ORDER BY t.school')
        .all(person.id);

  res.render('people-list', {
    title: `${person.name} · ${listingFollowers ? 'Followers' : 'Following'}`,
    person,
    personPath: profilePath(person),
    listingFollowers,
    people,
    teams,
    profilePath,
  });
});

module.exports = router;
module.exports.followStats = followStats;
