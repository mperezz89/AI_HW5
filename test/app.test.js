const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

let server;
let baseUrl;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highlight-reel-'));
  const app = createApp({ dbPath: ':memory:', uploadDir: path.join(tmpDir, 'uploads'), sessionSecret: 'test', maxUploadBytes: 1024 * 1024 });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal cookie-jar client so each test user keeps their own session.
function client() {
  let cookie = '';
  return async function request(pathname, { method = 'GET', form, body } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(baseUrl + pathname, { method, headers, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  };
}

async function signUp(request, { name, email, role }) {
  const res = await request('/register', { method: 'POST', form: { name, email, role, password: 'password123' } });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/profile/edit');
}

function videoForm(fields, { type = 'video/mp4', bytes = Buffer.from('fake video bytes') } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('video', new Blob([bytes], { type }), 'clip.mp4');
  return fd;
}

const athlete = client();
const coach = client();
const otherCoach = client();
let athleteId;
let videoId;
let videoPath;

test('athlete signs up, fills profile, and uploads a highlight', async () => {
  await signUp(athlete, { name: 'Jordan Rivers', email: 'jordan@example.com', role: 'athlete' });

  let res = await athlete('/profile/edit', {
    method: 'POST',
    form: { name: 'Jordan Rivers', sport: 'Basketball', position: 'Point Guard', grad_year: '2027', state: 'IN', high_school: 'Central HS', phone: '555-0100' },
  });
  assert.equal(res.status, 302);
  athleteId = Number(res.location.split('/').pop());

  res = await athlete('/videos', { method: 'POST', body: videoForm({ title: '30 pts vs North', sport: 'Basketball', opponent: 'North' }) });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/videos\/\d+$/);
  videoId = Number(res.location.split('/').pop());

  res = await athlete(`/videos/${videoId}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /30 pts vs North/);
  videoPath = res.text.match(/src="(\/media\/[^"#]+)/)[1];

  const media = await athlete(videoPath);
  assert.equal(media.status, 200);
  assert.equal(media.text, 'fake video bytes');
});

test('upload rejects non-video files and oversized files', async () => {
  let res = await athlete('/videos', { method: 'POST', body: videoForm({ title: 'nope' }, { type: 'text/plain' }) });
  assert.equal(res.status, 400);
  assert.match(res.text, /Only MP4, MOV, or WebM/);

  res = await athlete('/videos', { method: 'POST', body: videoForm({ title: 'big' }, { bytes: Buffer.alloc(2 * 1024 * 1024) }) });
  assert.equal(res.status, 400);
  assert.match(res.text, /too large/);
});

test('coaches cannot upload videos', async () => {
  await signUp(coach, { name: 'Coach Kim', email: 'kim@college.edu', role: 'coach' });
  await coach('/profile/edit', { method: 'POST', form: { school: 'State University', title: 'Assistant Coach', sport: 'Basketball', division: 'NCAA D1' } });
  const res = await coach('/videos', { method: 'POST', body: videoForm({ title: 'x' }) });
  assert.equal(res.status, 403);
});

test('coach finds the athlete by filters', async () => {
  let res = await coach('/athletes?sport=Basketball&grad_year=2027&state=IN');
  assert.match(res.text, /Jordan Rivers/);
  res = await coach('/athletes?sport=Football');
  assert.doesNotMatch(res.text, /Jordan Rivers/);
});

test('views count only for non-owners', async () => {
  await coach(`/videos/${videoId}`);
  await athlete(`/videos/${videoId}`);
  const res = await athlete('/dashboard');
  assert.match(res.text, /<dt>Total views<\/dt><dd>1<\/dd>/);
});

test('visit request flow hides contact info until accepted', async () => {
  let res = await coach(`/athletes/${athleteId}`);
  assert.doesNotMatch(res.text, /555-0100/);
  assert.match(res.text, /Contact info is shared once/);

  res = await coach(`/athletes/${athleteId}/visit-requests`, {
    method: 'POST',
    form: { message: 'Loved your film — come visit campus!', proposed_date: '2026-11-15', video_id: String(videoId) },
  });
  assert.equal(res.status, 302);

  // Duplicate pending requests are blocked.
  await coach(`/athletes/${athleteId}/visit-requests`, { method: 'POST', form: { message: 'again' } });
  res = await athlete('/dashboard');
  assert.equal((res.text.match(/Loved your film/g) || []).length, 1);
  assert.doesNotMatch(res.text, /again/);
  assert.match(res.text, /State University/);

  const requestId = res.text.match(/\/visit-requests\/(\d+)\/respond/)[1];

  // Another coach's account cannot respond, nor can a different athlete.
  await signUp(otherCoach, { name: 'Coach Lee', email: 'lee@college.edu', role: 'coach' });
  res = await otherCoach(`/visit-requests/${requestId}/respond`, { method: 'POST', form: { decision: 'accept' } });
  assert.equal(res.status, 403);

  res = await athlete(`/visit-requests/${requestId}/respond`, {
    method: 'POST',
    form: { decision: 'accept', response_message: 'See you there!' },
  });
  assert.equal(res.status, 302);

  res = await coach(`/athletes/${athleteId}`);
  assert.match(res.text, /555-0100/);
  assert.match(res.text, /jordan@example.com/);

  res = await otherCoach(`/athletes/${athleteId}`);
  assert.doesNotMatch(res.text, /555-0100/);

  res = await coach('/dashboard');
  assert.match(res.text, /accepted/);
  assert.match(res.text, /See you there!/);
});

test('athlete can delete their own video, removing the file', async () => {
  let res = await coach(`/videos/${videoId}/delete`, { method: 'POST' });
  assert.equal(res.status, 403);

  res = await athlete(`/videos/${videoId}/delete`, { method: 'POST' });
  assert.equal(res.status, 302);
  res = await athlete(`/videos/${videoId}`);
  assert.equal(res.status, 404);
  res = await athlete(videoPath);
  assert.equal(res.status, 404);
});

test('login rejects bad passwords and does not open-redirect', async () => {
  const anon = client();
  let res = await anon('/login', { method: 'POST', form: { email: 'jordan@example.com', password: 'wrong-password' } });
  assert.equal(res.status, 401);
  res = await anon('/login', { method: 'POST', form: { email: 'jordan@example.com', password: 'password123', next: '//evil.com' } });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/');
});

test('athlete fills in the preferred profile attributes', async () => {
  let res = await athlete('/dashboard');
  assert.match(res.text, /profile fields complete/);
  assert.match(res.text, /<li>Athlete ID<\/li>/);

  res = await athlete('/profile/edit', {
    method: 'POST',
    form: {
      athlete_code: 'NCAA-2027-0042',
      sport: 'Basketball',
      high_school: 'Central HS',
      position: 'Point Guard',
      position_rank: '#12',
      star_rating: '4',
      national_rank: '150',
      city: 'South Bend',
      state: 'IN',
      bio: 'Two-year varsity starter.',
    },
  });
  assert.equal(res.status, 302);

  res = await coach(`/athletes/${athleteId}`);
  assert.match(res.text, /NCAA-2027-0042/);
  assert.match(res.text, /★★★★☆/);
  assert.match(res.text, /#12/);
  assert.match(res.text, /#150/);
  assert.match(res.text, /South Bend, IN/);

  res = await athlete('/dashboard');
  assert.match(res.text, /<strong>9 of 9<\/strong> profile fields complete/);
});

test('profile rejects invalid rankings and duplicate Athlete IDs', async () => {
  const cases = [
    [{ star_rating: '6' }, /Star ranking must be between 1 and 5/],
    [{ national_rank: 'top 10' }, /National ranking must be a whole number/],
    [{ position_rank: '0' }, /Position ranking must be a whole number/],
  ];
  for (const [form, message] of cases) {
    const res = await athlete('/profile/edit', { method: 'POST', form });
    assert.equal(res.status, 400);
    assert.match(res.text, message);
  }

  const other = client();
  await signUp(other, { name: 'Sam Ortiz', email: 'sam@example.com', role: 'athlete' });
  const res = await other('/profile/edit', { method: 'POST', form: { athlete_code: 'ncaa-2027-0042' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /already in use/);
  await other('/profile/edit', { method: 'POST', form: { sport: 'Basketball', star_rating: '5', national_rank: '3' } });
});

test('coaches can search by Athlete ID, filter by stars, and sort by national ranking', async () => {
  let res = await coach('/athletes?q=NCAA-2027');
  assert.match(res.text, /Jordan Rivers/);
  assert.doesNotMatch(res.text, /Sam Ortiz/);

  res = await coach('/athletes?min_stars=5');
  assert.match(res.text, /Sam Ortiz/);
  assert.doesNotMatch(res.text, /Jordan Rivers/);

  res = await coach('/athletes?sport=Basketball&sort=national_rank');
  assert.ok(res.text.indexOf('Sam Ortiz') < res.text.indexOf('Jordan Rivers'), 'rank #3 should list before #150');
});

test('existing databases gain the new profile columns', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDatabase } = require('../src/db');
  const file = path.join(tmpDir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE athlete_profiles (user_id INTEGER PRIMARY KEY, sport TEXT, position TEXT)');
  old.close();

  const db = openDatabase(file);
  const columns = db.prepare('PRAGMA table_info(athlete_profiles)').all().map((c) => c.name);
  for (const c of ['athlete_code', 'position_rank', 'star_rating', 'national_rank']) assert.ok(columns.includes(c), c);
  db.close();
});

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

function postForm(caption, { type = 'image/png', bytes = PNG_1PX, name = 'photo.png' } = {}) {
  const fd = new FormData();
  fd.append('caption', caption);
  fd.append('media', new Blob([bytes], { type }), name);
  return fd;
}

test('coaches post to their team page; setup is required first', async () => {
  // Coach Lee has no school or sport yet, so there is no team to post as.
  let res = await otherCoach('/posts/new');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/profile/edit');

  // Coach Kim set school + sport earlier, so their team exists.
  res = await coach('/posts', { method: 'POST', body: postForm('Welcome to campus! #GoState') });
  assert.equal(res.status, 302);
  res = await coach(res.location);
  assert.match(res.text, /Welcome to campus!/);
  assert.match(res.text, /State University/);

  res = await coach('/posts', { method: 'POST', body: postForm('practice clip', { type: 'video/mp4', bytes: Buffer.from('vid'), name: 'a.mp4' }) });
  assert.equal(res.status, 302);

  res = await coach('/posts', { method: 'POST', body: postForm('bad', { type: 'application/pdf', name: 'a.pdf' }) });
  assert.equal(res.status, 400);
  assert.match(res.text, /must be a photo/);

  // Athletes cannot post as a team.
  res = await athlete('/posts', { method: 'POST', body: postForm('hi') });
  assert.equal(res.status, 403);

  // A second coach from the same school and sport joins the same team, regardless of capitalization.
  await otherCoach('/profile/edit', { method: 'POST', form: { school: 'state university', sport: 'Basketball', title: 'Head Coach' } });
  await otherCoach('/posts', { method: 'POST', body: postForm('Camp registration is open') });
  res = await otherCoach('/teams/mine');
  const teamPath = res.location;
  res = await otherCoach(teamPath);
  assert.match(res.text, /<strong>3<\/strong> posts/);
  assert.match(res.text, /Coach Kim/);
  assert.match(res.text, /Coach Lee/);
});

test('athlete home is the feed: discover by sport, follow teams, and like posts', async () => {
  // A football team that should not show up in a basketball athlete's default Discover tab.
  const fbCoach = client();
  await signUp(fbCoach, { name: 'Coach Fox', email: 'fox@tech.edu', role: 'coach' });
  await fbCoach('/profile/edit', { method: 'POST', form: { school: 'Tech College', sport: 'Football' } });
  await fbCoach('/posts', { method: 'POST', body: postForm('Friday night lights') });

  let res = await athlete('/');
  assert.equal(res.location, '/feed');

  // Not following anyone yet: lands on Discover, filtered to the athlete's sport.
  res = await athlete('/feed');
  assert.match(res.text, /Camp registration is open/);
  assert.doesNotMatch(res.text, /Friday night lights/);
  assert.match(res.text, /Teams you might like/);

  res = await athlete('/feed?tab=discover&sport=all');
  assert.match(res.text, /Friday night lights/);

  res = await athlete('/feed?tab=following');
  assert.match(res.text, /not following any teams yet/);

  // Follow the football team only; the Following tab shows just its posts.
  res = await athlete('/teams?sport=Football');
  const footballTeamId = res.text.match(/action="\/teams\/(\d+)\/follow"/)[1];
  res = await athlete(`/teams/${footballTeamId}/follow`, { method: 'POST', form: { back: '/teams' } });
  assert.equal(res.location, '/teams');

  res = await athlete('/feed');
  assert.match(res.text, /class="active">Following/);
  assert.match(res.text, /Friday night lights/);
  assert.doesNotMatch(res.text, /Camp registration is open/);

  // Like, then unlike.
  const postId = res.text.match(/id="post-(\d+)"/)[1];
  res = await athlete(`/posts/${postId}/like`, { method: 'POST', form: { back: '/feed?tab=following' } });
  assert.equal(res.location, `/feed?tab=following#post-${postId}`);
  res = await athlete(`/posts/${postId}`);
  assert.match(res.text, /1 like</);
  assert.match(res.text, /aria-pressed="true"/);
  await athlete(`/posts/${postId}/like`, { method: 'POST', form: { back: '//evil.com' } });
  res = await athlete(`/posts/${postId}`);
  assert.match(res.text, /0 likes/);

  // Following shows on the team page; unfollow toggles it off.
  res = await athlete(`/teams/${footballTeamId}`);
  assert.match(res.text, /<strong>1<\/strong> follower</);
  await athlete(`/teams/${footballTeamId}/follow`, { method: 'POST' });
  res = await athlete(`/teams/${footballTeamId}`);
  assert.match(res.text, /<strong>0<\/strong> followers/);

  // Coaches cannot follow teams.
  res = await coach(`/teams/${footballTeamId}/follow`, { method: 'POST' });
  assert.equal(res.status, 403);
});

test('only the author can delete a team post, which removes its file', async () => {
  let res = await coach('/feed?tab=discover&sport=Basketball');
  const article = res.text.split('<article').find((a) => a.includes('Welcome to campus'));
  const postId = article.match(/id="post-(\d+)"/)[1];
  res = await coach(`/posts/${postId}`);
  const mediaPath = res.text.match(/src="(\/media\/[^"#]+)/)[1];

  res = await otherCoach(`/posts/${postId}/delete`, { method: 'POST' });
  assert.equal(res.status, 404);
  res = await coach(`/posts/${postId}/delete`, { method: 'POST' });
  assert.equal(res.status, 302);
  assert.equal((await coach(`/posts/${postId}`)).status, 404);
  assert.equal((await coach(mediaPath)).status, 404);
});

test('timeAgo labels', () => {
  const { timeAgo } = require('../src/constants');
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(timeAgo('2026-10-04 11:59:30', now), 'just now');
  assert.equal(timeAgo('2026-10-04 09:00:00', now), '3h ago');
  assert.equal(timeAgo('2026-09-20 12:00:00', now), '2w ago');
});
