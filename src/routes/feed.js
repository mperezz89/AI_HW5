const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { singleUpload } = require('../uploads');
const { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES } = require('../constants');

const router = express.Router();

const PAGE_SIZE = 10;

const postUpload = singleUpload({
  field: 'media',
  mimeTypes: [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES],
  typeError: 'Posts must be a photo (JPG, PNG, WebP, GIF) or a video (MP4, MOV, WebM).',
  onError: (req, res, error) =>
    res.status(400).render('post-new', { title: 'New post', team: coachTeam(req), error, caption: (req.body || {}).caption || '' }),
});

function localPath(p, fallback) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : fallback;
}

function coachTeam(req) {
  return req.app.locals.db
    .prepare('SELECT t.* FROM coach_profiles c JOIN teams t ON t.id = c.team_id WHERE c.user_id = ?')
    .get(req.user.id);
}

// Posts matching `where`, newest first, with team info and like counts for the viewer.
function findPosts(db, viewerId, { where = [], params = [], limit = PAGE_SIZE, offset = 0 }) {
  return db
    .prepare(
      `SELECT p.*, t.school, t.sport, t.division, u.name AS author_name,
              (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
              EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
       FROM posts p
       JOIN teams t ON t.id = p.team_id
       JOIN users u ON u.id = p.author_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(viewerId, ...params, limit, offset);
}

// The Following tab: posts from followed teams and coaches, plus highlight videos from followed
// athletes, newest first. Returns items shaped { kind: 'post' | 'highlight', ...row }.
function followingItems(db, user, { limit, offset }) {
  const refs = db
    .prepare(
      `SELECT 'post' AS kind, p.id, p.created_at FROM posts p
       WHERE p.team_id IN (SELECT team_id FROM team_follows WHERE athlete_id = ?)
          OR p.author_id IN (SELECT followee_id FROM user_follows WHERE follower_id = ?)
       UNION ALL
       SELECT 'highlight', v.id, v.created_at FROM videos v
       WHERE v.athlete_id IN (SELECT followee_id FROM user_follows WHERE follower_id = ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(user.id, user.id, user.id, limit, offset);

  const ids = (kind) => refs.filter((r) => r.kind === kind).map((r) => r.id);
  const postIds = ids('post');
  const videoIds = ids('highlight');
  const posts = postIds.length
    ? findPosts(db, user.id, { where: [`p.id IN (${postIds.map(() => '?').join(',')})`], params: postIds, limit: postIds.length })
    : [];
  const videos = videoIds.length
    ? db
        .prepare(
          `SELECT v.*, u.name AS athlete_name, a.sport AS athlete_sport, a.position, a.high_school, a.star_rating
           FROM videos v JOIN users u ON u.id = v.athlete_id LEFT JOIN athlete_profiles a ON a.user_id = v.athlete_id
           WHERE v.id IN (${videoIds.map(() => '?').join(',')})`
        )
        .all(...videoIds)
    : [];
  const byKey = new Map([
    ...posts.map((p) => [`post:${p.id}`, { kind: 'post', ...p }]),
    ...videos.map((v) => [`highlight:${v.id}`, { kind: 'highlight', ...v }]),
  ]);
  return refs.map((r) => byKey.get(`${r.kind}:${r.id}`));
}

router.get('/feed', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const isAthlete = req.user.role === 'athlete';
  const followingCount =
    db.prepare('SELECT COUNT(*) AS n FROM team_follows WHERE athlete_id = ?').get(req.user.id).n +
    db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE follower_id = ?').get(req.user.id).n;
  const mySport = isAthlete
    ? (db.prepare('SELECT sport FROM athlete_profiles WHERE user_id = ?').get(req.user.id) || {}).sport
    : null;

  let tab = req.query.tab;
  if (!['following', 'discover'].includes(tab)) tab = followingCount ? 'following' : 'discover';
  // Discover defaults to the athlete's own sport; "all" shows every sport.
  const sport = req.query.sport === 'all' ? '' : req.query.sport || mySport || '';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const window = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };

  const items =
    tab === 'following'
      ? followingItems(db, req.user, window)
      : findPosts(db, req.user.id, { where: sport ? ['t.sport = ?'] : [], params: sport ? [sport] : [], ...window }).map(
          (p) => ({ kind: 'post', ...p })
        );

  const suggestions = isAthlete
    ? db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM team_follows f WHERE f.team_id = t.id) AS followers
           FROM teams t
           WHERE t.id NOT IN (SELECT team_id FROM team_follows WHERE athlete_id = ?)
           ORDER BY (t.sport = ?) DESC, followers DESC, t.school
           LIMIT 5`
        )
        .all(req.user.id, mySport || '')
    : [];

  const query = new URLSearchParams({ tab });
  if (tab === 'discover') query.set('sport', sport || 'all');
  const back = `/feed?${query}${page > 1 ? `&page=${page}` : ''}`;
  const nextPage = items.length === PAGE_SIZE ? `/feed?${query}&page=${page + 1}` : null;

  res.render('feed', { title: 'Feed', items, tab, sport, followingCount, suggestions, nextPage, isAthlete, back });
});

router.get('/teams', requireAuth, (req, res) => {
  const db = req.app.locals.db;
  const filters = { q: (req.query.q || '').trim(), sport: req.query.sport || '' };
  const where = [];
  const params = [req.user.id];
  if (filters.q) {
    where.push('t.school LIKE ?');
    params.push(`%${filters.q}%`);
  }
  if (filters.sport) {
    where.push('t.sport = ?');
    params.push(filters.sport);
  }
  const teams = db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM team_follows f WHERE f.team_id = t.id) AS followers,
              (SELECT COUNT(*) FROM posts p WHERE p.team_id = t.id) AS post_count,
              EXISTS (SELECT 1 FROM team_follows f WHERE f.team_id = t.id AND f.athlete_id = ?) AS following
       FROM teams t
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY followers DESC, t.school
       LIMIT 100`
    )
    .all(...params);
  res.render('teams', { title: 'College teams', teams, filters });
});

router.get('/teams/mine', requireRole('coach'), (req, res) => {
  const team = coachTeam(req);
  if (team) return res.redirect(`/teams/${team.id}`);
  req.session.flash = 'Add your school and sport to set up your team page.';
  res.redirect('/profile/edit');
});

router.get('/teams/:id', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return next();

  const followers = db.prepare('SELECT COUNT(*) AS n FROM team_follows WHERE team_id = ?').get(team.id).n;
  const following = !!db
    .prepare('SELECT 1 FROM team_follows WHERE team_id = ? AND athlete_id = ?')
    .get(team.id, req.user.id);
  const coaches = db
    .prepare(
      `SELECT u.id, u.name, c.title FROM coach_profiles c JOIN users u ON u.id = c.user_id
       WHERE c.team_id = ? ORDER BY u.name`
    )
    .all(team.id);
  const posts = findPosts(db, req.user.id, { where: ['p.team_id = ?'], params: [team.id], limit: 60 });
  const isTeamCoach = coaches.some((c) => c.id === req.user.id);

  res.render('team-show', { title: team.school, team, followers, following, coaches, posts, isTeamCoach });
});

router.post('/teams/:id/follow', requireRole('athlete'), (req, res, next) => {
  const db = req.app.locals.db;
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return next();
  const removed = db.prepare('DELETE FROM team_follows WHERE team_id = ? AND athlete_id = ?').run(team.id, req.user.id);
  if (!removed.changes) db.prepare('INSERT INTO team_follows (team_id, athlete_id) VALUES (?, ?)').run(team.id, req.user.id);
  res.redirect(localPath(req.body.back, `/teams/${team.id}`));
});

router.get('/posts/new', requireRole('coach'), (req, res) => {
  const team = coachTeam(req);
  if (!team) {
    req.session.flash = 'Add your school and sport first. Posts are shared as your team.';
    return res.redirect('/profile/edit');
  }
  res.render('post-new', { title: 'New post', team, error: null, caption: '' });
});

router.post('/posts', requireRole('coach'), postUpload, (req, res) => {
  const db = req.app.locals.db;
  const team = coachTeam(req);
  const caption = (req.body.caption || '').trim();
  if (!team || !req.file) {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (!team) return res.redirect('/posts/new');
    return res.status(400).render('post-new', { title: 'New post', team, error: 'Choose a photo or video to post.', caption });
  }

  const kind = req.file.mimetype.startsWith('image/') ? 'image' : 'video';
  const { lastInsertRowid } = db
    .prepare('INSERT INTO posts (team_id, author_id, caption, media_filename, media_kind, mime_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(team.id, req.user.id, caption || null, req.file.filename, kind, req.file.mimetype);

  req.session.flash = 'Posted to your team page.';
  res.redirect(`/posts/${lastInsertRowid}`);
});

router.get('/posts/:id', requireAuth, (req, res, next) => {
  const [post] = findPosts(req.app.locals.db, req.user.id, { where: ['p.id = ?'], params: [Number(req.params.id)], limit: 1 });
  if (!post) return next();
  res.render('post-show', { title: post.school, post });
});

router.post('/posts/:id/like', requireAuth, (req, res, next) => {
  const db = req.app.locals.db;
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  const removed = db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(post.id, req.user.id);
  if (!removed.changes) db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
  res.redirect(`${localPath(req.body.back, `/posts/${post.id}`)}#post-${post.id}`);
});

router.post('/posts/:id/delete', requireRole('coach'), (req, res, next) => {
  const db = req.app.locals.db;
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!post) return next();
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  fs.unlink(path.join(req.app.locals.uploadDir, post.media_filename), () => {});
  req.session.flash = 'Post deleted.';
  res.redirect(`/teams/${post.team_id}`);
});

module.exports = router;
