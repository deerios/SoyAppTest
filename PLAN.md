# SoyBot V2 Plan: Devvit for Reddit posting

## Why

V1 posts to Reddit with praw, which needs a Reddit API app (client id/secret)
plus a bot account password. We don't have a Reddit API key. Devvit apps
authenticate by being installed on a subreddit instead, so they can post
without any of that.

## What stays the same

GitHub Actions keeps doing everything it already does in V1:

- `DiscordReader` polls the channel for new messages, finds YouTube links
- `YouTubeClient` fetches video info and transcript
- `DescriptionExtractor` picks creator description vs. AI summary, truncates
  to the first line
- `State` tracks the last processed Discord message ID
- Discord and GitHub rate limits are respected the same way as V1 (discord.py
  handles Discord limits internally; state is committed via `git push`, not
  the GitHub REST API, so we don't spend API quota there)

## What changes

Reddit posting moves out of GitHub Actions and into a small Devvit app
installed on the target subreddit. GitHub Actions can't call into a Devvit
app directly (Devvit apps don't expose a public inbound endpoint to
arbitrary callers without Reddit's approval for `externalEndpoints`), so the
two sides connect through a queue file instead of a direct API call:

1. GitHub Actions writes `queue.json` to the repo: one entry per YouTube
   video found, each with the video ID, subreddit, title, summary text, and
   flag (`creator-summarized` / `soybot-summarized`). It regenerates this
   file each run from its own Discord state, capped to a recent window
   (e.g. the last 50 videos) — it does not need to know what Devvit has or
   hasn't posted yet.
2. The Devvit app runs its own scheduler job (every few minutes, using
   Devvit's built-in scheduler, no GitHub Actions cron needed for this leg).
   The job fetches `queue.json` over HTTPS from
   `raw.githubusercontent.com/<org>/<repo>/main/queue.json` (requires
   `permissions.http` in `devvit.json` allowing that domain).
3. The Devvit app keeps its own record of which video IDs it has already
   posted, in Devvit's Redis-backed storage (`permissions.redis`). For each
   queue entry not already recorded, it calls `reddit.submitPost()` and then
   marks the video ID as posted in Redis.

This keeps state ownership simple: GitHub Actions owns "which Discord
messages have we seen", Devvit owns "which videos have we posted". Neither
side needs to call back into the other's API, so there's no GitHub token
inside the Devvit app and no Reddit credentials inside GitHub Actions.

Reddit rate limits are handled by the Devvit runtime itself, since
`reddit.submitPost()` runs through Reddit's own platform rather than a
client library we control.

## Components to build

- `queue_writer.py` (or a method on the existing `Pipeline` in `app.py`):
  replaces `RedditClient` as the last pipeline step. Instead of submitting a
  post, it appends/updates an entry in `queue.json` and commits it (same
  `git push` step already in the workflow).
- Devvit app (new, separate project, TypeScript):
  - `devvit.json` with a `scheduler` task (e.g. every 5 minutes) pointing at
    an internal endpoint, and `permissions.http` allowlisting
    `raw.githubusercontent.com`, and `permissions.redis` enabled
  - server handler: fetch `queue.json`, diff against Redis-recorded posted
    IDs, call `reddit.submitPost({ subredditName, title, text })` for each
    new entry, record the ID in Redis
  - deployed with `devvit deploy` / `devvit publish` and installed on the
    target subreddit

## Things to confirm before/while building (Devvit specifics can shift)

- Exact Devvit scheduler cron config syntax and job registration reliability
  (there are open Devvit GitHub issues about scheduled jobs not firing
  consistently — worth a small spike before committing to this design)
- Confirm `permissions.redis` API shape for a simple posted-ID set/lookup
- Confirm `raw.githubusercontent.com` is an acceptable domain under
  `permissions.http`, or whether the queue should be hosted elsewhere (e.g.
  GitHub Pages) if raw.githubusercontent.com isn't reliably allowlistable
- Decide the queue window size (how many recent videos GitHub Actions keeps
  in `queue.json`) so it never grows unbounded but also never drops a video
  before Devvit has had a chance to see it
- Devvit apps are reviewed/approved by Reddit before they can post
  automatically on a subreddit at any volume — confirm approval requirements
  for an automated posting bot before relying on this for production use

## Migration steps

1. Prototype the Devvit app in isolation (scheduler job + Redis + a
   hardcoded `submitPost` call) to confirm the platform basics work on our
   test subreddit
2. Add `permissions.http` and fetch a static test JSON file to confirm
   outbound fetch works from inside a scheduled job
3. Replace the hardcoded post with real `queue.json` parsing and the
   Redis-backed dedupe check
4. Remove `RedditClient`/praw from `app.py`, add the queue-writing step,
   drop the `REDDIT_*` secrets from the GitHub Actions workflow
5. Update `posted_videos.json` handling in `app.py`: it now only needs to
   track "included in queue" rather than "posted to Reddit", since posting
   status lives in Devvit's Redis
6. Test end to end on a private test subreddit before pointing at the real
   one
