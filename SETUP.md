# Setup

Two independent pieces:

- **soybot** (`app.py`) — Discord bot that watches a channel for YouTube links, builds a title/summary, and pushes an entry to a Discord "queue" channel.
- **devvit app** (`devvit/`) — Reddit app that polls the queue channel every 5 min and posts to the subreddit.

They only talk to each other through that Discord queue channel.

## 1. Discord bot

1. Create a Discord application + bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable the **Message Content** intent (Bot > Privileged Gateway Intents).
3. Invite it to your server with permission to read the source channel and send messages in the queue channel.
4. Grab the bot token.

## 2. YouTube Data API key

1. [Google Cloud Console](https://console.cloud.google.com) > APIs & Services > enable **YouTube Data API v3**.
2. Create an API key under Credentials.

## 3. soybot config

```bash
cp .env.example .env
```

Fill in `.env`:

```
DISCORD_BOT_TOKEN=...
YOUTUBE_API_KEY=...
ANTHROPIC_API_KEY=...   # optional — omit to disable AI summarization
```

Edit `config.yaml`:

```yaml
discord_channel_id: "..."        # channel soybot reads YouTube links from
discord_queue_channel_id: "..."  # channel soybot posts queue entries to
subreddit: "..."
creator_summarized_channels:     # YouTube channel IDs trusted to self-summarize
  - "UC..."
```

Any YouTube channel not in `creator_summarized_channels` requires `ANTHROPIC_API_KEY` to be set, since its videos get summarized from the transcript instead.

## 4. Run soybot

```bash
pip install -r requirements.txt
./run_local.sh
```

`run_local.sh` uses `config.yaml` but writes state to local, disposable `local_state.json` / `local_posted_videos.json` files instead of the committed ones.

Run it on a schedule (cron, GitHub Actions, etc.) for continuous operation — it processes new messages once per invocation and exits.

## 5. Devvit (Reddit) app

Requires Node 22.

```bash
cd devvit
npm create devvit@latest --template=bare   # first time only, follow the wizard
./run.sh                                    # installs deps, playtests on dev subreddit
```

In the Reddit developer settings for the installed app, set:

- **Queue Channel ID** — same value as `discord_queue_channel_id` above.
- **Discord Bot Token** — same bot token from step 1 (needs read access to the queue channel).

The app polls the queue channel every 5 minutes (`post-video` scheduled task) and posts new entries to the subreddit. The "Sync Queue Now" subreddit menu item triggers a check immediately.

To ship it: `npm run publish`.
