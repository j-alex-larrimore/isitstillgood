# IsItStillGood.com — Backend API

Node.js/Express REST API for a social review platform covering books, movies, TV shows, and games.

## Tech Stack
- **Runtime**: Node.js ≥ 18
- **Framework**: Express 4
- **Database**: PostgreSQL via Prisma 5 ORM
- **Auth**: Passport.js — Google OAuth 2.0 + local email/password
- **Sessions**: JWT access tokens (15 min) + rotating httpOnly refresh tokens (30 days)

---

## Quick Start

### 1. Install
```bash
npm install
cp .env.example .env   # then fill in your values
```

### 2. Required .env values
```
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/isitstillgood"
JWT_SECRET=<32+ char random string>
REFRESH_TOKEN_SECRET=<32+ char random string>
SESSION_SECRET=<32+ char random string>
```

### 3. Google OAuth setup
1. Go to https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add `http://localhost:3001/api/auth/google/callback` to redirect URIs
4. Copy Client ID and Secret into .env

### 4. Database
```bash
npm run db:migrate    # create tables
npm run db:seed       # optional: load sample data
npm run db:studio     # visual DB browser
```

### 5. Run
```bash
npm run dev    # development
npm start      # production
```
Server on http://localhost:3001

---

## Project Structure
```
isitstillgood/
├── prisma/
│   ├── schema.prisma          # Full database schema
│   └── seed.js                # Sample data
├── src/
│   ├── app.js                 # Express app (middleware, routes)
│   ├── server.js              # Entry point
│   ├── lib/
│   │   ├── prisma.js          # Shared PrismaClient
│   │   └── tokens.js          # JWT + refresh token helpers
│   ├── middleware/
│   │   ├── auth.js            # requireAuth / optionalAuth
│   │   └── passport.js        # Google OAuth + local strategy
│   ├── routes/
│   │   ├── auth.js            # /api/auth/*
│   │   ├── users.js           # /api/users/*
│   │   ├── media.js           # /api/media/*
│   │   ├── reviews.js         # /api/reviews/*
│   │   ├── friends.js         # /api/friends/*
│   │   ├── feed.js            # /api/feed/*
│   │   └── lists.js           # /api/lists/*
│   └── services/
│       └── externalRatings.js # OMDB, Google Books, OpenCritic
└── .env.example
```

---

## Data Model Summary

### MediaItem
One table covers all media types. `mediaType` enum: `MOVIE | BOOK | TV_SHOW | BOARD_GAME | VIDEO_GAME`

| Field | Notes |
|---|---|
| title, slug, releaseYear, description, imageUrl, genres | Universal |
| imdbRating (0–10), rtScore (0–100), rtAudienceScore | Movies/TV — synced via OMDB |
| goodreadsRating (0–5) | Books — synced via Google Books |
| openCriticScore (0–100), metacriticScore | Games |
| directors, cast (Person[]) | Movies & TV |
| authors (Person[]) | Books |
| designers (Person[]) | Board games |
| seasons, episodes, streamingOn | TV shows |
| minPlayers, maxPlayers, playTimeMinutes | Board games |
| platforms | Video games |

### Review
One review per user per media item (updatable/revisitable).

| Field | Notes |
|---|---|
| rating | **Integer 1–10** |
| verdict | Auto-computed: `TIMELESS` (9-10), `STILL_GOOD` (7-8), `MIXED` (4-6), `NOT_GOOD` (1-3) |
| reviewText | Optional written review |
| spoilerText | Optional, shown behind spoiler gate on frontend |
| visibility | `PUBLIC | FRIENDS_ONLY | PRIVATE` (defaults to user's account setting) |
| isRevisit, previousRating | Preserved when a user changes an old rating |

### User
- Supports both local (email/password) and Google OAuth — or both linked to one account
- `defaultVisibility` applied to all new reviews automatically
- `profilePublic: false` restricts profile to friends only

### Friendship
Directed edge: `PENDING → ACCEPTED` or `BLOCKED`. Query helpers check both directions.

---

## API Reference

Base URL: `http://localhost:3001/api`  
Auth: Bearer token in `Authorization` header, OR `access_token` httpOnly cookie.

### Auth  `/api/auth`
| | Endpoint | Auth | |
|---|---|---|---|
| POST | /register | — | Create account |
| POST | /login | — | Login (email+password) |
| POST | /refresh | — | Rotate refresh token |
| POST | /logout | ✓ | Revoke session |
| POST | /logout-all | ✓ | Revoke all sessions |
| GET | /me | ✓ | Current user |
| GET | /google | — | Start Google OAuth |
| GET | /google/callback | — | Google OAuth callback |
| PATCH | /change-password | ✓ | Change password |

### Users  `/api/users`
| | Endpoint | Auth | |
|---|---|---|---|
| GET | /:username | optional | Public profile |
| PATCH | /me | ✓ | Update profile |
| GET | /:username/reviews | optional | Review timeline |
| GET | /search?q= | ✓ | Find users |

### Media  `/api/media`
| | Endpoint | Auth | |
|---|---|---|---|
| GET | / | optional | Search (`?q=&type=&genre=&year=&page=`) |
| GET | /:slug | optional | Item detail + community stats |
| POST | / | ✓ | Create media item |
| PATCH | /:id | ✓ | Update media item |
| GET | /:slug/reviews | optional | Reviews for item |
| POST | /:id/sync-ratings | ✓ | Re-fetch external ratings |

### Reviews  `/api/reviews`
| | Endpoint | Auth | |
|---|---|---|---|
| GET | /:id | optional | Review + comments |
| POST | / | ✓ | Create or update review |
| DELETE | /:id | ✓ | Delete own review |
| POST | /:id/react | ✓ | Toggle emoji reaction |
| POST | /:id/comments | ✓ | Add comment / reply |
| DELETE | /:reviewId/comments/:id | ✓ | Delete own comment |

**POST /reviews body:**
```json
{
  "mediaItemId": "clx...",
  "rating": 8,
  "reviewText": "Still holds up.",
  "spoilerText": "The ending recontextualizes everything.",
  "visibility": "PUBLIC"
}
```

### Friends  `/api/friends`
| | Endpoint | Auth | |
|---|---|---|---|
| GET | / | ✓ | My friend list |
| GET | /requests | ✓ | Incoming requests |
| POST | /request/:userId | ✓ | Send request |
| POST | /accept/:friendshipId | ✓ | Accept request |
| DELETE | /decline/:friendshipId | ✓ | Decline or unfriend |
| POST | /block/:userId | ✓ | Block user |
| GET | /status/:userId | ✓ | Friendship status |

### Feed  `/api/feed`
| | Endpoint | Auth | |
|---|---|---|---|
| GET | / | ✓ | Friend activity feed (`?page=&mediaType=`) |
| GET | /trending | ✓ | Top items among friends (30 days) |
| GET | /notifications | ✓ | Notifications + unread count |
| POST | /notifications/read-all | ✓ | Mark all read |

### Lists  `/api/lists`
| | Endpoint | Auth | |
|---|---|---|---|
| GET | /:username | optional | User's public lists |
| POST | / | ✓ | Create list |
| POST | /:listId/items | ✓ | Add item |
| DELETE | /:listId/items/:mediaItemId | ✓ | Remove item |

---

## External Ratings Sync

| Service | Data fetched | Required env vars |
|---|---|---|
| OMDB (omdbapi.com — free) | IMDB rating, RT score, Metacritic | `OMDB_API_KEY` + item's `imdbId` |
| Google Books (free) | Reader rating (Goodreads proxy) | `GOOGLE_BOOKS_API_KEY` + `goodreadsId` |
| OpenCritic | Games critic score | `OPENCRITC_API_KEY` + `openCriticId` |

Ratings fetch automatically on item creation. Refresh stale ratings:
```bash
npm run ratings:refresh
```

Recommended cron (nightly at 3am):
```
0 3 * * * cd /path/to/app && npm run ratings:refresh >> /var/log/ratings.log 2>&1
```

---

## Auth Flow

**Google OAuth (browser):**
1. Frontend → `GET /api/auth/google` → redirects to Google
2. Google → `/api/auth/google/callback` → server sets httpOnly cookies
3. Frontend lands on `/auth/callback?success=true`, calls `/api/auth/me`

**Email/password:**
1. `POST /api/auth/login` → sets cookies + returns `accessToken` in body
2. On 401 `TOKEN_EXPIRED` → `POST /api/auth/refresh` to rotate
3. Mobile: use `Authorization: Bearer <token>` header instead of cookies

---

## Deployment Checklist
- [ ] `NODE_ENV=production`
- [ ] Real Postgres (`DATABASE_URL`)
- [ ] Strong secrets (JWT, refresh, session)
- [ ] Production `CLIENT_URL` and Google OAuth callback URL registered
- [ ] `npm run db:migrate:prod` (not `:migrate` — never resets data)
- [ ] HTTPS enabled (required for secure cookies and Google OAuth)
- [ ] Nightly cron for `ratings:refresh`
