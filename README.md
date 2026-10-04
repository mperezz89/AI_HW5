# Highlight Reel

A web app where **athletes** upload raw game highlight videos to get exposure, and **college coaches** browse those athletes and send **visit requests**.

## Features

**Athletes**
- Sign up as an athlete and build a recruiting profile: sport, position, graduation year, school, city/state, height, weight, GPA, bio, and phone.
- Upload raw game video (MP4, MOV, or WebM, up to 500 MB) with a title, opponent, game date, and notes.
- Dashboard with highlight count, total views from other users, and incoming visit requests.
- Accept or decline a visit request, with an optional reply.
- Delete your own videos. This also removes the file from disk.

**Coaches**
- Sign up as a coach and list your school, title, sport, and division.
- Search athletes by name, school, city, or Athlete ID. Filter by sport, position, grad year, state, and minimum star ranking, and sort by national ranking.
- Watch highlights. Video views are counted, and an athlete's own views are not.
- Send a visit request with a message, a proposed date, and optionally the video that caught your eye. You can have only one pending request per athlete at a time.
- Track request status (pending, accepted, or declined) on your dashboard.

**Privacy:** an athlete's email and phone stay hidden from coaches until the athlete accepts that coach's visit request. Many athletes on a platform like this are minors, so contact is opt-in.

## Tech stack

- Node.js 22.13 or newer with Express. Pages are rendered on the server with EJS.
- SQLite through Node's built-in `node:sqlite`, so there is no native database dependency.
- Multer handles uploads. Videos are stored on local disk and served with HTTP range support, so the player can seek.
- Passwords are hashed with scrypt. Sessions use `express-session` cookies set to `httpOnly` and `sameSite=lax`.

## Running it

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test           # end-to-end tests (node:test)
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | random on each start | Signs session cookies. Set it so logins survive a restart. |

Data is stored in `data/app.db` and uploaded videos in `uploads/`. Git ignores both.

## Project layout

```
src/
  app.js            Express app factory (configurable DB path, upload dir, limits)
  server.js         Entry point
  db.js             SQLite schema
  auth.js           Password hashing and auth/role middleware
  constants.js      Sports, states, allowed video types
  routes/           auth, profile, videos, athletes (search/profile), visits (dashboard + requests)
views/              EJS templates
public/styles.css   Styles (light and dark mode)
test/app.test.js    End-to-end tests
```

## Before going to production

- Video encoding: browsers play H.264 MP4 and WebM, but some phone uploads (for example HEVC `.mov` files from iPhones) won't play in every browser. Add an ffmpeg transcode step, and generate thumbnails in the same pass.
- Storage: move videos to object storage (S3, GCS, or R2) behind a CDN, and use direct-to-bucket uploads for large files.
- Sessions: replace the in-memory session store with a persistent one, such as Redis or SQLite.
- Security: add CSRF tokens, rate limiting on login and upload, email verification, and verification that coaches really work for the programs they list.
- Verification: rankings and Athlete IDs are self-reported. Consider verifying them against an official source or labeling them as self-reported.
- Product: messaging, saved athletes for coaches, email notifications for new visit requests, and reporting and moderation for uploaded content.
