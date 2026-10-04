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
  assert.equal(res.location, '/dashboard');
});
