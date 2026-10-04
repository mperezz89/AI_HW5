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
  await coach('/profile/edit', { method: 'POST', form: { school: 'State University', title: 'Assistant', sport: 'Basketball', division: 'NCAA D1' } });
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

test('coaches open a visit calendar to invited athletes, who book a time', async () => {
  // Without an Athlete ID, a coach can't open their calendar to an athlete.
  let res = await coach(`/athletes/${athleteId}`);
  assert.doesNotMatch(res.text, /555-0100/);
  assert.match(res.text, /Contact info is shared once/);
  assert.match(res.text, /hasn't added an Athlete ID yet/);
  await athlete('/profile/edit', {
    method: 'POST',
    form: { athlete_code: 'NCAA-2027-0042', sport: 'Basketball', position: 'Point Guard', grad_year: '2027', state: 'IN', high_school: 'Central HS', phone: '555-0100' },
  });
  res = await coach(`/athletes/${athleteId}`);
  assert.match(res.text, /You have no open times yet/);

  // Coach Kim adds open times; past or malformed times are rejected.
  res = await coach('/calendar/slots', { method: 'POST', form: { starts_at: '2020-01-01T10:00' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /must be in the future/);
  res = await coach('/calendar/slots', { method: 'POST', form: { starts_at: 'soon' } });
  assert.equal(res.status, 400);
  await coach('/calendar/slots', {
    method: 'POST',
    form: { starts_at: '2099-11-14T10:00', duration_minutes: '120', capacity: '1', location: 'Athletics center front desk' },
  });
  await coach('/calendar/slots', { method: 'POST', form: { starts_at: '2099-11-21T09:00', duration_minutes: '240', capacity: '2' } });
  res = await coach('/calendar');
  assert.match(res.text, /Saturday, November 14, 2099/);
  assert.match(res.text, /10:00 AM – 12:00 PM/);

  // The calendar is private: athletes without access have nothing to book.
  res = await athlete('/dashboard');
  assert.doesNotMatch(res.text, /Choose a visit time/);

  // Opening the calendar takes a real Athlete ID and a message.
  res = await coach('/calendar/access', { method: 'POST', form: { athlete_code: 'NOPE-123', message: 'Hi' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /No athlete has the Athlete ID NOPE-123/);
  res = await coach('/calendar/access', { method: 'POST', form: { athlete_code: 'NCAA-2027-0042', message: '' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /Include a message/);

  // Athlete IDs match regardless of case; a second open invitation is blocked.
  res = await coach('/calendar/access', {
    method: 'POST',
    form: { athlete_code: 'ncaa-2027-0042', message: 'Loved your film — come visit campus!', video_id: String(videoId) },
  });
  assert.equal(res.location, '/calendar');
  res = await coach('/calendar');
  assert.match(res.text, /now open to Jordan Rivers \(NCAA-2027-0042\)/);
  assert.match(res.text, /Athletes with access[\s\S]*Jordan Rivers[\s\S]*Choosing a time/);
  res = await coach('/calendar/access', { method: 'POST', form: { athlete_code: 'NCAA-2027-0042', message: 'again' } });
  assert.match(res.text, /already open to Jordan Rivers/);
  res = await athlete('/dashboard');
  assert.equal((res.text.match(/Loved your film/g) || []).length, 1);
  assert.doesNotMatch(res.text, /again/);
  assert.match(res.text, /Invited/);
  assert.match(res.text, /2 times on the coach's calendar/);
  const requestId = res.text.match(/\/visit-requests\/(\d+)\/schedule/)[1];

  res = await athlete(`/visit-requests/${requestId}/schedule`);
  assert.match(res.text, /Saturday, November 14, 2099/);
  assert.match(res.text, /Saturday, November 21, 2099/);
  assert.match(res.text, /Athletics center front desk/);
  const [slotA, slotB] = [...res.text.matchAll(/name="slot_id" value="(\d+)"/g)].map((m) => m[1]);

  // Other people can't see or use this invitation.
  await signUp(otherCoach, { name: 'Coach Lee', email: 'lee@college.edu', role: 'coach' });
  assert.equal((await otherCoach(`/visit-requests/${requestId}/schedule`)).status, 403);
  const casey = client();
  await signUp(casey, { name: 'Casey Park', email: 'casey@example.com', role: 'athlete' });
  assert.equal((await casey(`/visit-requests/${requestId}/schedule`)).status, 404);

  // A different coach's time can't be booked through Kim's invitation.
  await otherCoach('/calendar/slots', { method: 'POST', form: { starts_at: '2099-12-01T10:00' } });
  const leeSlot = (await otherCoach('/calendar')).text.match(/\/calendar\/slots\/(\d+)\/delete/)[1];
  res = await athlete(`/visit-requests/${requestId}/schedule`, { method: 'POST', form: { slot_id: leeSlot } });
  assert.equal(res.location, `/visit-requests/${requestId}/schedule`);

  // Jordan books slot A, which unlocks contact info for Kim only.
  res = await athlete(`/visit-requests/${requestId}/schedule`, {
    method: 'POST',
    form: { slot_id: slotA, response_message: 'See you there!' },
  });
  assert.equal(res.location, '/dashboard');
  res = await athlete('/dashboard');
  assert.match(res.text, /Scheduled/);
  assert.match(res.text, /Sat, Nov 14, 2099 · 10:00 AM – 12:00 PM/);

  res = await coach(`/athletes/${athleteId}`);
  assert.match(res.text, /555-0100/);
  assert.match(res.text, /jordan@example.com/);
  assert.match(res.text, /Scheduled<\/span> Sat, Nov 14, 2099/);
  res = await otherCoach(`/athletes/${athleteId}`);
  assert.doesNotMatch(res.text, /555-0100/);

  res = await coach('/dashboard');
  assert.match(res.text, /Scheduled/);
  assert.match(res.text, /See you there!/);
  res = await coach('/calendar');
  assert.match(res.text, /1 of 1 booked/);
  assert.match(res.text, /Jordan Rivers/);

  // Slot A is now full for other invited athletes; booked slots can't be removed.
  await casey('/profile/edit', { method: 'POST', form: { sport: 'Basketball', athlete_code: 'CASEY-28' } });
  // Opening from the athlete's profile page returns there.
  res = await coach('/calendar/access', {
    method: 'POST',
    form: { athlete_code: 'CASEY-28', message: 'Come visit too!', back: '/athletes/1' },
  });
  assert.equal(res.location, '/athletes/1');
  res = await casey('/dashboard');
  const caseyRequest = res.text.match(/\/visit-requests\/(\d+)\/schedule/)[1];
  res = await casey(`/visit-requests/${caseyRequest}/schedule`);
  assert.doesNotMatch(res.text, /November 14/);
  assert.match(res.text, /November 21/);
  await casey(`/visit-requests/${caseyRequest}/schedule`, { method: 'POST', form: { slot_id: slotA } });
  assert.match((await casey('/dashboard')).text, /Invited/);

  await coach(`/calendar/slots/${slotA}/delete`, { method: 'POST' });
  assert.match((await coach('/calendar')).text, /November 14/);

  // Reschedule to slot B, cancel, then book slot A again.
  await athlete(`/visit-requests/${requestId}/schedule`, { method: 'POST', form: { slot_id: slotB } });
  assert.match((await athlete('/dashboard')).text, /Sat, Nov 21, 2099/);
  assert.match((await coach('/calendar')).text, /0 of 1 booked/);
  await athlete(`/visit-requests/${requestId}/cancel`, { method: 'POST' });
  assert.match((await athlete('/dashboard')).text, /Invited/);
  assert.doesNotMatch((await coach(`/athletes/${athleteId}`)).text, /555-0100/);
  await athlete(`/visit-requests/${requestId}/schedule`, { method: 'POST', form: { slot_id: slotA } });
  assert.match((await coach(`/athletes/${athleteId}`)).text, /555-0100/);

  // Coaches can withdraw access before the athlete books, but not after.
  const taylor = client();
  await signUp(taylor, { name: 'Taylor Brooks', email: 'taylor@example.com', role: 'athlete' });
  await taylor('/profile/edit', { method: 'POST', form: { athlete_code: 'TB-2028' } });
  await coach('/calendar/access', { method: 'POST', form: { athlete_code: 'TB-2028', message: 'Visit us!' } });
  res = await taylor('/dashboard');
  const taylorRequest = res.text.match(/\/visit-requests\/(\d+)\/schedule/)[1];
  res = await coach('/calendar');
  const withdrawIds = [...res.text.matchAll(/\/calendar\/access\/(\d+)\/withdraw/g)].map((m) => m[1]);
  assert.ok(withdrawIds.includes(taylorRequest));
  assert.ok(!withdrawIds.includes(requestId), 'booked visits cannot be withdrawn');
  assert.equal((await otherCoach(`/calendar/access/${taylorRequest}/withdraw`, { method: 'POST' })).status, 404);
  await coach(`/calendar/access/${taylorRequest}/withdraw`, { method: 'POST' });
  assert.equal((await taylor(`/visit-requests/${taylorRequest}/schedule`)).status, 404);
  assert.doesNotMatch((await taylor('/dashboard')).text, /Choose a visit time/);

  // Declining closes the invitation.
  await casey(`/visit-requests/${caseyRequest}/respond`, { method: 'POST', form: { decision: 'decline' } });
  res = await casey('/dashboard');
  assert.match(res.text, /declined/);
  assert.equal((await casey(`/visit-requests/${caseyRequest}/schedule`)).location, '/dashboard');
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
  assert.match(res.text, /<li>Star ranking<\/li>/);

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
  await otherCoach('/profile/edit', { method: 'POST', form: { school: 'state university', sport: 'Basketball', title: 'Coach' } });
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
  assert.match(res.text, /not following anyone yet/);

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

test('athletes build a following of athletes and coaches; Following feed shows their content', async () => {
  // A second athlete with a highlight, and Jordan follows them plus Coach Kim.
  const riley = client();
  await signUp(riley, { name: 'Riley Chen', email: 'riley@example.com', role: 'athlete' });
  let res = await riley('/profile/edit', { method: 'POST', form: { sport: 'Soccer', position: 'Striker' } });
  const rileyId = Number(res.location.split('/').pop());
  await riley('/videos', { method: 'POST', body: videoForm({ title: 'Hat trick vs. West' }) });

  res = await coach('/teams/mine');
  const kimId = Number((await coach(res.location)).text.match(/href="\/coaches\/(\d+)">Coach Kim/)[1]);

  res = await athlete(`/people/${rileyId}/follow`, { method: 'POST' });
  assert.equal(res.location, `/athletes/${rileyId}`);
  await athlete(`/people/${kimId}/follow`, { method: 'POST' });

  // Athlete following athlete shows on both profiles.
  res = await riley(`/athletes/${rileyId}`);
  assert.match(res.text, /<strong>1<\/strong> follower</);
  res = await riley(`/people/${rileyId}/followers`);
  assert.match(res.text, /Jordan Rivers/);

  // Coaches can follow athletes too, building the athlete's following.
  await coach(`/people/${athleteId}/follow`, { method: 'POST' });
  await riley(`/people/${athleteId}/follow`, { method: 'POST' });
  res = await riley(`/athletes/${athleteId}`);
  assert.match(res.text, /<strong>2<\/strong> followers/);
  res = await riley(`/people/${athleteId}/followers`);
  assert.match(res.text, /Coach Kim/);
  assert.match(res.text, /Riley Chen/);

  // Following list includes people and teams.
  res = await athlete(`/people/${athleteId}/following`);
  assert.match(res.text, /Riley Chen/);
  assert.match(res.text, /Coach Kim/);

  // Following feed: Riley's highlight and Coach Kim's team posts, but not other teams' posts.
  res = await athlete('/feed?tab=following');
  assert.match(res.text, /Hat trick vs. West/);
  assert.match(res.text, /practice clip/);
  assert.doesNotMatch(res.text, /Friday night lights/);

  // Coach profile page with follow counts; following yourself is a no-op.
  res = await athlete(`/coaches/${kimId}`);
  assert.match(res.text, /Assistant · State University/);
  assert.match(res.text, /<strong>1<\/strong> follower</);
  await athlete(`/people/${athleteId}/follow`, { method: 'POST' });
  res = await athlete(`/athletes/${athleteId}`);
  assert.match(res.text, /<strong>2<\/strong> followers/);

  // Unfollow toggles off.
  await athlete(`/people/${rileyId}/follow`, { method: 'POST' });
  res = await athlete('/feed?tab=following');
  assert.doesNotMatch(res.text, /Hat trick vs. West/);
});

test('athletes message coaches directly and teams through a shared inbox', async () => {
  const kimTeam = (await coach('/teams/mine')).location;
  const teamId = kimTeam.split('/').pop();
  const kimId = Number((await coach(kimTeam)).text.match(/href="\/coaches\/(\d+)">Coach Kim/)[1]);

  // Direct message to Coach Kim.
  let res = await athlete(`/messages/new?coach=${kimId}`);
  assert.match(res.text, /Message Coach Kim/);
  res = await athlete('/messages', { method: 'POST', form: { coach: String(kimId), body: '   ' } });
  assert.equal(res.status, 400);
  res = await athlete('/messages', { method: 'POST', form: { coach: String(kimId), body: 'Hi Coach Kim, I am a 2027 PG.' } });
  assert.equal(res.status, 302);
  const directPath = res.location.replace('#latest', '');

  // Kim sees an unread badge, reads it, and replies.
  res = await coach('/dashboard');
  assert.match(res.text, /aria-label="1 unread"/);
  res = await coach(directPath);
  assert.match(res.text, /I am a 2027 PG/);
  res = await coach('/dashboard');
  assert.doesNotMatch(res.text, /unread"/);
  await coach(directPath, { method: 'POST', form: { body: 'Thanks Jordan! Send me your schedule.' } });

  res = await athlete('/messages');
  assert.match(res.text, /Send me your schedule/);
  assert.match(res.text, /aria-label="1 unread"/);

  // Starting again with the same coach reuses the conversation.
  res = await athlete(`/messages/new?coach=${kimId}`);
  assert.equal(res.location, directPath);

  // Team inbox: Coach Lee (same team) and Coach Kim can both read and reply; Coach Fox cannot.
  res = await athlete('/messages', { method: 'POST', form: { team: teamId, body: 'Interested in your summer camp.' } });
  const teamPath = res.location.replace('#latest', '');
  res = await otherCoach(teamPath);
  assert.equal(res.status, 200);
  assert.match(res.text, /Interested in your summer camp/);
  await otherCoach(teamPath, { method: 'POST', form: { body: 'Camp info is on our team page!' } });
  res = await coach(teamPath);
  assert.match(res.text, /Camp info is on our team page!/);
  assert.match(res.text, /Coach Lee/);

  // Coach Lee can't see Kim's direct conversation; outsiders can't see either.
  assert.equal((await otherCoach(directPath)).status, 404);
  const fox = client();
  await fox('/login', { method: 'POST', form: { email: 'fox@tech.edu', password: 'password123' } });
  assert.equal((await fox(teamPath)).status, 404);
  assert.equal((await fox(teamPath, { method: 'POST', form: { body: 'sneaky' } })).status, 404);

  // Coaches reply but don't start conversations; another athlete can't read Jordan's.
  res = await coach('/messages', { method: 'POST', form: { coach: String(kimId), body: 'x' } });
  assert.equal(res.status, 403);
  const riley = client();
  await riley('/login', { method: 'POST', form: { email: 'riley@example.com', password: 'password123' } });
  assert.equal((await riley(directPath)).status, 404);
});

test('coaches fill in title, Team ID, team name, and team sport', async () => {
  const drew = client();
  await signUp(drew, { name: 'Drew Hall', email: 'drew@lakeside.edu', role: 'coach' });

  let res = await drew('/dashboard');
  assert.match(res.text, /<strong>0 of 4<\/strong> profile fields complete/);
  assert.match(res.text, /<li>Team ID<\/li>/);

  // Title must be one of the three choices, and a Team ID needs a team name and sport.
  res = await drew('/profile/edit', { method: 'POST', form: { title: 'Head Honcho' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /Choose Coach, Recruiter, or Assistant/);
  res = await drew('/profile/edit', { method: 'POST', form: { team_code: 'LAKE-WBB' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /Add your team name and team sport/);

  res = await drew('/profile/edit', {
    method: 'POST',
    form: { title: 'Recruiter', team_code: 'LAKE-WBB', school: 'Lakeside University', sport: 'Basketball', division: 'NCAA D3' },
  });
  assert.equal(res.status, 302);
  const profilePath = res.location;
  assert.match(profilePath, /^\/coaches\/\d+$/);

  res = await drew(profilePath);
  assert.match(res.text, /<dt>Title<\/dt><dd>Recruiter<\/dd>/);
  assert.match(res.text, /LAKE-WBB/);
  assert.match(res.text, /Lakeside University/);
  assert.match(res.text, /<dt>Team sport<\/dt><dd>Basketball<\/dd>/);
  assert.doesNotMatch(res.text, /Still missing/);
  res = await drew('/dashboard');
  assert.match(res.text, /<strong>4 of 4<\/strong> profile fields complete/);

  // The form shows saved values back.
  res = await drew('/profile/edit');
  assert.match(res.text, /<option selected>Recruiter<\/option>/);
  assert.match(res.text, /value="LAKE-WBB"/);

  // Another coach entering the same Team ID (any capitalization) joins that team under its name.
  const morgan = client();
  await signUp(morgan, { name: 'Morgan Fry', email: 'morgan@lakeside.edu', role: 'coach' });
  res = await morgan('/profile/edit', {
    method: 'POST',
    form: { title: 'Assistant', team_code: 'lake-wbb', school: 'Lakeside Univ.', sport: 'Basketball' },
  });
  assert.equal(res.status, 302);
  res = await morgan(res.location);
  assert.match(res.text, /registered to Lakeside University/);
  const teamPath = res.text.match(/<a class="post-team" href="(\/teams\/\d+)"/)[1];
  res = await morgan(teamPath);
  assert.match(res.text, /Team ID LAKE-WBB/);
  assert.match(res.text, /Drew Hall/);
  assert.match(res.text, /Morgan Fry/);

  // A Team ID can't be reused for a different sport or a team already registered with another ID.
  const sam = client();
  await signUp(sam, { name: 'Sam Lee', email: 'sam@lakeside.edu', role: 'coach' });
  res = await sam('/profile/edit', { method: 'POST', form: { team_code: 'LAKE-WBB', school: 'Lakeside University', sport: 'Soccer' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /belongs to Lakeside University Basketball/);
  res = await sam('/profile/edit', { method: 'POST', form: { team_code: 'OTHER-1', school: 'Lakeside University', sport: 'Basketball' } });
  assert.equal(res.status, 400);
  assert.match(res.text, /already registered with a different Team ID/);
});

test('existing free-text coach titles map onto Coach, Recruiter, or Assistant', () => {
  const { openDatabase } = require('../src/db');
  const file = path.join(tmpDir, 'titles.db');
  let db = openDatabase(file);
  const insert = db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?, 'x', 'coach', ?)");
  const titles = { 'Assistant Coach': 'Assistant', 'Recruiting Coordinator': 'Recruiter', 'Head Coach': 'Coach', Recruiter: 'Recruiter' };
  for (const [i, title] of Object.keys(titles).entries()) {
    const id = Number(insert.run(`c${i}@x.edu`, `C${i}`).lastInsertRowid);
    db.prepare('INSERT INTO coach_profiles (user_id, title) VALUES (?, ?)').run(id, title);
  }
  db.close();

  db = openDatabase(file);
  const after = db.prepare('SELECT title FROM coach_profiles ORDER BY user_id').all().map((r) => r.title);
  assert.deepEqual(after, Object.values(titles));
  db.close();
});
