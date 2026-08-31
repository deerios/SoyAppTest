import asyncio
import json
import os
import re
from abc import ABC, abstractmethod

import anthropic
import discord
import requests
import yaml
import yt_dlp

YOUTUBE_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com/watch\?v=[\w-]+|youtu\.be/[\w-]+)\S*"
)
VTT_TAG_RE = re.compile(r"<[^>]+>")
VTT_TIMESTAMP_LINE_RE = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3} -->")
CREATOR_SUMMARIZED = "creator-summarized"
SOYBOT_SUMMARIZED = "soybot-summarized"
SUMMARY_PROMPT = (
    "Summarize the following YouTube video transcript in one sentence, "
    "suitable as a short post description. Reply with only the sentence.\n\n"
    "Transcript:\n{transcript}"
)


def first_line(text: str) -> str:
    return text.split("\n", 1)[0].strip()


class Config:
    """Loads static settings: which channel to read, which subreddit to post to,
    and which YouTube channels self-summarize their descriptions."""

    def __init__(self, path: str):
        with open(path, "r") as f:
            data = yaml.safe_load(f) or {}
        self.discord_channel_id = data["discord_channel_id"]
        self.subreddit = data["subreddit"]
        self.creator_summarized_channels = set(data.get("creator_summarized_channels", []))

    def is_creator_summarized(self, youtube_channel_id: str) -> bool:
        return youtube_channel_id in self.creator_summarized_channels


class State:
    """Tracks the last Discord message we processed so a scheduled run
    doesn't reprocess or skip messages."""

    def __init__(self, path: str):
        self.path = path
        self.last_message_id = None
        if os.path.exists(path):
            with open(path, "r") as f:
                data = json.load(f)
            self.last_message_id = data.get("last_message_id")

    def save(self):
        with open(self.path, "w") as f:
            json.dump({"last_message_id": self.last_message_id}, f)


class PostedVideos:
    """Tracks which YouTube videos we've already queued for Reddit, keyed by
    video ID, so a video is never queued twice."""

    def __init__(self, path: str):
        self.path = path
        self.entries = {}
        if os.path.exists(path):
            with open(path, "r") as f:
                self.entries = json.load(f)

    def is_posted(self, video_id: str) -> bool:
        return video_id in self.entries

    def mark(self, video_id: str, status: str):
        self.entries[video_id] = {"status": status}
        self.save()

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.entries, f, indent=2)


class QueueWriter:
    """Appends newly processed videos to queue.json for the Devvit app to
    pick up and post to Reddit. Keeps only the most recent MAX_ENTRIES so
    the file doesn't grow unbounded."""

    MAX_ENTRIES = 50

    def __init__(self, path: str):
        self.path = path
        self.entries = []
        if os.path.exists(path):
            with open(path, "r") as f:
                self.entries = json.load(f)

    def add(self, video_id: str, subreddit: str, title: str, summary: str, flag: str):
        self.entries.append({
            "videoId": video_id,
            "subreddit": subreddit,
            "title": title,
            "summary": summary,
            "flag": flag,
        })
        self.entries = self.entries[-self.MAX_ENTRIES:]
        self.save()

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.entries, f, indent=2)


class DiscordReader:
    """Reads messages from a channel using discord.py. discord.py already
    respects Discord's rate limits internally, so no extra throttling needed
    here. This connects, fetches history since the last run, then disconnects."""

    def __init__(self, token: str):
        self.token = token

    def fetch_new_messages(self, channel_id: str, after_message_id: str = None) -> list:
        return asyncio.run(self._fetch(channel_id, after_message_id))

    async def _fetch(self, channel_id: str, after_message_id: str) -> list:
        intents = discord.Intents.default()
        intents.message_content = True
        client = discord.Client(intents=intents)
        messages = []

        @client.event
        async def on_ready():
            try:
                channel = await client.fetch_channel(int(channel_id))
                after = discord.Object(id=int(after_message_id)) if after_message_id else None
                async for message in channel.history(limit=100, after=after, oldest_first=True):
                    messages.append(message)
            finally:
                await client.close()

        await client.start(self.token)
        return messages

    @staticmethod
    def extract_youtube_links(messages: list) -> list:
        """Returns (message_id, url) pairs for each YouTube link found."""
        links = []
        for message in messages:
            for match in YOUTUBE_URL_RE.finditer(message.content):
                links.append((message.id, match.group(0)))
        return links


class VideoInfo:
    def __init__(self, video_id: str, channel_id: str, description: str, title: str):
        self.video_id = video_id
        self.channel_id = channel_id
        self.description = description
        self.title = title


class YouTubeClient:
    """Wraps yt-dlp to fetch video metadata and transcripts (via subtitles),
    without downloading any video or audio."""

    def __init__(self, transcript_lang: str = "en"):
        self.transcript_lang = transcript_lang

    # Hosted CI runners share IP ranges YouTube flags for bot-check
    # ("Sign in to confirm you're not a bot"). The android client skips
    # that check, at the cost of being an unofficial workaround yt-dlp/
    # YouTube can break at any time.
    _EXTRACTOR_ARGS = {"youtube": {"player_client": ["android"]}}

    def get_video_info(self, url: str) -> VideoInfo:
        opts = {
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "extractor_args": self._EXTRACTOR_ARGS,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        return VideoInfo(
            video_id=info["id"],
            channel_id=info.get("channel_id", ""),
            description=info.get("description", "") or "",
            title=info.get("title", ""),
        )

    def get_transcript(self, url: str) -> str:
        """Downloads the subtitle track (creator captions if available,
        otherwise auto-generated) and returns it as plain text."""
        opts = {
            "skip_download": True,
            "quiet": True,
            "no_warnings": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": [self.transcript_lang],
            "extractor_args": self._EXTRACTOR_ARGS,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)

        subtitles = info.get("requested_subtitles") or {}
        track = subtitles.get(self.transcript_lang)
        if not track:
            raise ValueError(f"No {self.transcript_lang} transcript available for {url}")

        response = requests.get(track["url"])
        response.raise_for_status()
        return self._vtt_to_text(response.text)

    @staticmethod
    def _vtt_to_text(vtt: str) -> str:
        lines = []
        for line in vtt.splitlines():
            line = line.strip()
            if not line or line == "WEBVTT" or line.isdigit():
                continue
            if VTT_TIMESTAMP_LINE_RE.match(line):
                continue
            text = VTT_TAG_RE.sub("", line)
            if text and (not lines or lines[-1] != text):
                lines.append(text)
        return " ".join(lines)


class Summarizer(ABC):
    @abstractmethod
    def summarize(self, transcript: str) -> str:
        ...


class ClaudeSummarizer(Summarizer):
    def __init__(self, api_key: str, model: str = "claude-sonnet-5"):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model

    def summarize(self, transcript: str) -> str:
        message = self.client.messages.create(
            model=self.model,
            max_tokens=200,
            messages=[{"role": "user", "content": SUMMARY_PROMPT.format(transcript=transcript)}],
        )
        return message.content[0].text.strip()


class DescriptionExtractor:
    """Picks the creator's own description if they're flagged as trustworthy,
    otherwise summarizes the transcript ourselves. Either way, only the first
    line is kept."""

    def __init__(self, config: Config, youtube_client: YouTubeClient, summarizer: Summarizer = None):
        self.config = config
        self.youtube_client = youtube_client
        self.summarizer = summarizer

    def extract(self, video_info: VideoInfo, url: str) -> tuple:
        if self.config.is_creator_summarized(video_info.channel_id):
            return first_line(video_info.description), CREATOR_SUMMARIZED

        if self.summarizer is None:
            raise ValueError("AI summarization is disabled (no ANTHROPIC_API_KEY set)")

        transcript = self.youtube_client.get_transcript(url)
        summary = self.summarizer.summarize(transcript)
        return first_line(summary), SOYBOT_SUMMARIZED


class Pipeline:
    """Ties the whole flow together: poll Discord for new YouTube links,
    build a summary for each, queue it for the subreddit, and remember how
    far we got."""

    def __init__(
        self,
        config: Config,
        state: State,
        posted_videos: PostedVideos,
        discord_reader: DiscordReader,
        youtube_client: YouTubeClient,
        description_extractor: DescriptionExtractor,
        queue_writer: QueueWriter,
    ):
        self.config = config
        self.state = state
        self.posted_videos = posted_videos
        self.discord_reader = discord_reader
        self.youtube_client = youtube_client
        self.description_extractor = description_extractor
        self.queue_writer = queue_writer

    def run(self):
        messages = self.discord_reader.fetch_new_messages(
            self.config.discord_channel_id, self.state.last_message_id
        )
        links = self.discord_reader.extract_youtube_links(messages)

        for message_id, url in links:
            self._process_link(url)
            self.state.last_message_id = message_id
            self.state.save()

    def _process_link(self, url: str):
        video_info = self.youtube_client.get_video_info(url)
        if self.posted_videos.is_posted(video_info.video_id):
            return

        try:
            summary, flag = self.description_extractor.extract(video_info, url)
            title = f"{video_info.title} [{flag}]"
            self.queue_writer.add(video_info.video_id, self.config.subreddit, title, summary, flag)
            self.posted_videos.mark(video_info.video_id, "queued")
        except Exception as e:
            self.posted_videos.mark(video_info.video_id, "failed")
            print(f"Failed to queue video {video_info.video_id}: {e}")


def main():
    config = Config(os.environ.get("SOYBOT_CONFIG_PATH", "config.yaml"))
    state = State(os.environ.get("SOYBOT_STATE_PATH", "state.json"))
    posted_videos = PostedVideos(os.environ.get("SOYBOT_POSTED_VIDEOS_PATH", "posted_videos.json"))

    discord_reader = DiscordReader(token=os.environ["DISCORD_BOT_TOKEN"])
    youtube_client = YouTubeClient()
    anthropic_api_key = os.environ.get("ANTHROPIC_API_KEY")
    summarizer = ClaudeSummarizer(api_key=anthropic_api_key) if anthropic_api_key else None
    description_extractor = DescriptionExtractor(config, youtube_client, summarizer)
    queue_writer = QueueWriter(os.environ.get("SOYBOT_QUEUE_PATH", "queue.json"))

    pipeline = Pipeline(
        config=config,
        state=state,
        posted_videos=posted_videos,
        discord_reader=discord_reader,
        youtube_client=youtube_client,
        description_extractor=description_extractor,
        queue_writer=queue_writer,
    )
    pipeline.run()


if __name__ == "__main__":
    main()
