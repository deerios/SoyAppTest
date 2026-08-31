import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, redis, settings} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  type DiscordMessage,
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type QueueEntry,
} from '../shared/api.ts'

type AnyRsp = UiResponse | TriggerResponse | ErrorRsp

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnAppInstall:
        rsp = await routeAppInstall()
        break
      case Endpoint.OnSchedulePostVideo:
        rsp = await routeSchedulePostVideo()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function routeMenuNewPost(): Promise<UiResponse> {
  const {created} = await processQueue()
  return {
    showToast: {
      text:
        created > 0
          ? `Posted ${created} new video${created === 1 ? '' : 's'}.`
          : 'No new videos to post.',
      appearance: 'success',
    },
  }
}

async function routeAppInstall(): Promise<TriggerResponse> {
  await processQueue()
  return {}
}

async function routeSchedulePostVideo(): Promise<TriggerResponse> {
  await processQueue()
  return {}
}

async function processQueue(): Promise<{created: number}> {
  const [queueChannelId, discordBotToken] = await Promise.all([
    settings.get<string>('queueChannelId'),
    settings.get<string>('discordBotToken'),
  ])
  if (!queueChannelId || !discordBotToken) return {created: 0}

  let messages: DiscordMessage[]
  try {
    const rsp = await fetch(
      `https://discord.com/api/v10/channels/${queueChannelId}/messages?limit=100`,
      {headers: {Authorization: `Bot ${discordBotToken}`}},
    )
    if (!rsp.ok) throw Error(`fetch failed with status ${rsp.status}`)
    messages = (await rsp.json()) as DiscordMessage[]
  } catch (err) {
    console.error(
      `queue fetch failed; ${err instanceof Error ? err.message : err}`,
    )
    return {created: 0}
  }

  const entries: QueueEntry[] = []
  for (const message of messages) {
    if (!message.author?.bot) continue
    try {
      entries.push(JSON.parse(message.content) as QueueEntry)
    } catch {
      // Not one of our queue messages; ignore.
    }
  }

  let created = 0
  for (const entry of entries) {
    if (entry.subreddit !== context.subredditName) continue
    if (await redis.exists(postedKey(entry.videoId))) continue

    try {
      const post = await reddit.submitPost({
        subredditName: context.subredditName,
        title: entry.title,
        url: `https://www.youtube.com/watch?v=${entry.videoId}`,
      })
      await redis.set(postedKey(entry.videoId), '1')
      created++

      try {
        await post.addComment({text: entry.summary})
      } catch (err) {
        console.error(
          `failed to comment on video ${entry.videoId} post; ${err instanceof Error ? err.message : err}`,
        )
      }
    } catch (err) {
      console.error(
        `failed to post video ${entry.videoId}; ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  return {created}
}

function postedKey(videoId: string): string {
  return `posted:${videoId}`
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
