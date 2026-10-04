# Highlight Reel

A web app where **athletes** upload raw game highlight videos to get exposure, and **college coaches** browse those athletes and send **visit requests**.

## Features

**Athletes**
- Sign up as an athlete and build a recruiting profile: sport, position, graduation year, school, city/state, height, weight, GPA, bio, and phone.
- Upload raw game video (MP4, MOV, or WebM, up to 500 MB) with a title, opponent, game date, and notes.
- Dashboard with highlight count, total views from other users, and incoming visit requests.
- Book a visit from a coach's invitation by picking an open time on the coach's calendar, with an optional note. Athletes can also reschedule, cancel, or decline.
- Delete your own videos. This also removes the file from disk.

**Home feed (Instagram-style)**
- After logging in, athletes land on a feed of photo and video posts from college teams.
- **Following** shows posts from teams the athlete follows. **Discover** shows posts from all teams, filtered to the athlete's sport by default; they can switch to any sport or all sports.
- A "Teams you might like" panel suggests teams in the athlete's sport that they don't follow yet.
- Athletes can like posts, follow or unfollow teams, and browse a directory of teams by school and sport.
- Each team has a page with its division, coaches, follower count, and a grid of its posts.

**Following**
- Athletes follow the college teams they're interested in.
- Anyone can follow athletes and coaches, so athletes build a following of other athletes and coaches. Athlete and coach profiles show follower and following counts, with lists of each.
- The **Following** feed tab shows posts from followed teams and coaches, plus new highlight videos from followed athletes.
- Coaches have public profile pages showing their team, follow counts, and posts.

**Direct messages**
- Athletes can message a coach directly from the coach's profile or a visit request, or message a whole team from its team page.
- A message to a team goes to a shared team inbox. Every coach on that team can read and reply to it.
- Coaches reply to athletes but can't start a conversation; visit requests remain how coaches reach out first.
- The inbox shows unread counts, and a badge in the navigation bar shows unread messages.

**Coaches**
- Sign up as a coach and list your school, title, sport, and division.
- Search athletes by name, school, city, or Athlete ID. Filter by sport, position, grad year, state, and minimum star ranking, and sort by national ranking.
- Watch highlights. Video views are counted, and an athlete's own views are not.
- **Visit calendar:** add open visit times with a date, start time, length, how many athletes can attend, and location or notes. A single time can be a one-on-one visit or a group event such as a junior day.
- **Invitations:** invite an athlete to visit from their profile, with a message and optionally the video that caught your eye. The invitation opens your calendar to that athlete, who books any open time. Only invited athletes can see your calendar, and you can have one open invitation or upcoming visit per athlete.
- See bookings on your calendar and dashboard. Times with bookings can't be removed.
- Post photos (JPG, PNG, WebP, GIF) or videos with captions to your team's page. Posts appear in athletes' feeds.
- A team is one school's program in one sport and is created from the school and sport in your settings. Coaches at the same school and sport share a team page; the school name is matched ignoring capitalization. Coaches can delete their own posts.

**Privacy:** an athlete's email and phone stay hidden from a coach until the athlete schedules a visit with that coach. Many athletes on a platform like this are minors, so contact is opt-in.

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
  uploads.js        Shared upload middleware for videos and images
  calendar.js       Visit calendar time helpers
  routes/           auth, profile, videos, athletes (search/profile), visits (dashboard + requests),
                    feed (home feed, teams, team posts, likes, follows), people (follows, coach profiles),
                    messages (direct and team-inbox messaging), calendar (visit times and booking)
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
- Teams: school names are typed in freely, so "Notre Dame" and "University of Notre Dame" become separate teams. Use a fixed list of schools, and verify that coaches belong to the team they post as.
- Feed: comments, Stories-style highlights, notifications when a followed team posts, and liking without reloading the page.
- Visit calendar: times are entered and shown as campus-local time without a time zone. Add per-school time zones, calendar file (.ics) or Google Calendar invites, reminders, and a way for coaches to move or cancel booked visits with notice to the athlete. Consider recruiting-calendar rules for official and unofficial visits.
- Messaging safety: many athletes are minors. Add reporting and blocking, keep messages for moderation, and consider letting parents or guardians see messages and coaches' messaging rules (for example, NCAA recruiting contact periods).
- Messaging: new messages only appear after a page reload. Add live updates and email or push notifications.
- Product: saved athletes for coaches, email notifications for new visit requests, and reporting and moderation for uploaded content.
