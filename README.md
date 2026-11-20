# Popcornhour

A small self-hosted tracker for the movies and TV shows you watch. It runs in Docker on your own computer or NAS, keeps its data in a single SQLite file, and fills itself from your [Trakt](https://trakt.tv) account.

**What it does**

- Imports your watched history, watchlist, ratings, lists and watched episodes from Trakt
- Library views for movies and TV (Watching, Watched, Watchlist, Favorites and more), with posters, scores and streaming availability
- Season and episode progress, and your own lists
- One shared password to sign in (it is built for one person or one household)

**What it does not do**

- It does not send anything back to Trakt. Sync to Trakt is switched off on purpose.
- It has no HTTPS or user accounts. Keep it on your home network, and do not expose it to the internet as it is.

This is a personal project that someone shared. It comes without support or guarantees, so keep a backup of your data folder.

---

## What you need before you start

1. **A machine that runs Docker.** A Synology NAS with DSM 7.2 or newer (Container Manager) works. So does any computer with Docker Compose.
2. **A free TMDB API key.** Make an account at [themoviedb.org](https://www.themoviedb.org), then go to Settings, then API, and request a key. It supplies titles, posters and details.
3. **A Trakt account and your own Trakt API app.** See [Connect Trakt](#connect-trakt). Trakt asks you to link a GitHub account before you can create an app.
4. **Optional:** an [OMDb](https://www.omdbapi.com) key (extra ratings) and an [MDBList](https://mdblist.com) key (a Rotten Tomatoes fallback).

---

## Settings (the `.env` file)

Copy `.env.example` to `.env` and fill it in. Never share this file or commit it anywhere.

| Variable | Needed? | What it is |
|---|---|---|
| `APP_PASSWORD` | Yes | The password you type to sign in |
| `SESSION_SECRET` | Yes | A long random string that signs your login cookie |
| `PUBLIC_URL` | Yes | Use `http://localhost:8080` (see Connect Trakt for why) |
| `TMDB_API_KEY` | Yes | Your TMDB key |
| `TRAKT_CLIENT_ID` | For Trakt | From your Trakt app |
| `TRAKT_CLIENT_SECRET` | For Trakt | From your Trakt app |
| `OMDB_API_KEY` | Optional | Extra ratings |
| `MDBLIST_API_KEY` | Optional | Rotten Tomatoes fallback |
| `CRON_SECRET` | Optional | Only if you schedule the new-seasons check |

Make a `SESSION_SECRET` with any of these:

```
openssl rand -hex 32
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

or use 64 random characters from a password manager. The app refuses to start if `APP_PASSWORD` or `SESSION_SECRET` is missing.

---

## Install on a Synology NAS (DSM 7.2 or newer)

1. In **File Station**, make a folder for the app, for example `/volume1/docker/popcornhour`, and a folder called `data` inside it. Container Manager will not create folders for you, and the project fails if a path is missing.
2. Download this repository as a ZIP (green **Code** button, then **Download ZIP**), unzip it, and upload the contents into that folder. `Dockerfile` and `docker-compose.yml` should sit directly in `popcornhour`.
3. In that folder, copy `.env.example` to `.env` and fill it in.
4. Open `docker-compose.yml` and check these lines:
   - **`ports:`** Change the number on the left to a free port. Avoid 5000 and 5001, which DSM uses. The number on the right stays `8080`.
   - **`user:`** The default is made for another system. Set it to your own user and group IDs. Over SSH, `id your-username` shows them. The first user on a Synology is often `1026`, and the group `users` is `100`, so the line would be `user: "1026:100"`. As a last resort, `"0:0"` runs the app as root, which works but is less tidy. If the app cannot save anything, the cause is almost always this line.
5. Open **Container Manager**, go to **Project**, and click **Create**. Name it, set the path to your folder, choose to use the existing `docker-compose.yml`, and let it build. The first build takes a few minutes, and a small NAS can be slow.
6. When the container shows as running, open `http://<NAS-IP>:<port>` in a browser and sign in with your `APP_PASSWORD`.

## Install with Docker Compose on any computer

```
cp .env.example .env
# edit .env, and check the ports: and user: lines in docker-compose.yml
docker compose up -d --build
```

The data lives in the `data` folder next to the compose file. Make sure the user set in `docker-compose.yml` can write to it.

---

## Connect Trakt

Trakt only allows `http://` redirect addresses for `localhost`. Your NAS has a different address, so the first connection uses a short temporary trick. You do it once, and the connection then keeps working on its own.

**1. Make a Trakt app.** Go to Trakt's *Your Apps* page and create an app named Popcornhour. Trakt may ask you to connect a GitHub account first. Set the redirect address to exactly:

```
http://localhost:8080/api/public/trakt/callback
```

Copy the Client ID and Client Secret into your `.env`, and keep `PUBLIC_URL=http://localhost:8080`. Restart the app after changing `.env`. Trakt may show a warning about the `http://` address, and its rules may change over time.

**2. Forward `localhost:8080` on your computer to the app, for a few minutes.**

Windows (PowerShell as administrator, with nothing else using port 8080):

```
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=8080 connectaddress=<NAS-IP> connectport=<port>
```

Mac or Linux (needs SSH enabled on the NAS):

```
ssh -N -L 8080:127.0.0.1:<port> <your-user>@<NAS-IP>
```

**3. Do the whole login at `http://localhost:8080`.** Sign in there, go to **Settings**, click **Connect Trakt**, approve it on Trakt, then run **Import**. Start at `localhost:8080` and finish there. If you begin at the NAS address, the sign-in check fails.

**4. Remove the forward.** Windows:

```
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=8080
```

On Mac or Linux, close the SSH window. From now on, use the NAS address normally. If Trakt ever says you are not connected, repeat these steps.

---

## Updating

Replace the changed files in the project folder (or pull the new code), then **Build** the project again in Container Manager, or run `docker compose up -d --build`. Your data folder is kept, and database changes are applied automatically when the app starts.

## Backups

Stop the container, then copy the `data` folder. It holds `app.db`, which also contains your Trakt login tokens, so keep backups private. Your library can always be rebuilt by importing from Trakt again.

## Optional: new-season check

The app can look for new seasons of shows you are watching. Set `CRON_SECRET` and have a scheduler call this once a day (Synology's Task Scheduler can do it):

```
curl -X POST -H "Authorization: Bearer <your CRON_SECRET>" http://<NAS-IP>:<port>/api/public/hooks/check-new-seasons
```

---

## Troubleshooting

- **The app starts but nothing can be saved, or the logs mention permissions.** The `user:` line does not match the owner of the `data` folder. See step 4 of the Synology install.
- **Login works but does not stay signed in.** `PUBLIC_URL` must start with `http://` when you use the app over plain HTTP.
- **After approving Trakt you land on a `state_mismatch` error.** You started at the NAS address and finished at `localhost`. Do the whole connection at `http://localhost:8080`.
- **Trakt says the redirect address is not valid.** The address in your Trakt app must be exactly `http://localhost:8080/api/public/trakt/callback`.
- **A port is already in use.** Pick another free port on the left of `ports:`.
- **The build is very slow or fails on a small NAS.** The build needs a fair amount of memory. Stop other containers while it runs.

## Security

- There is one shared password and no HTTPS. Use it on your home network only.
- Do not expose it to the internet without a reverse proxy that provides HTTPS.
- Keep `.env` and `data/app.db` private. They contain your keys and your Trakt login tokens.

---

## Credits and licence

Movie and TV data and images come from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Watch history comes from Trakt. Optional ratings come from OMDb and MDBList. Some extra features may rely on unofficial endpoints that can stop working.

Released under the MIT licence. See `LICENSE`.
