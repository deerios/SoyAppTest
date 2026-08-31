import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, beforeEach, test} from 'node:test'
import {
  type Context,
  type Post,
  reddit,
  redis,
  runWithContext,
  settings,
} from '@devvit/web/server'
import {Endpoint, type ErrorRsp, type QueueEntry} from '../shared/api.ts'
import {onReq} from './server.ts'

const QUEUE_URL =
  'https://raw.githubusercontent.com/example/example/main/queue.json'

let server: Server
let serverURL: string

const redisValues = new Map<string, string>()
let submittedPosts: {title: string; url?: string}[] = []
let comments: {postId: string; text: string}[] = []
let queueUrl: string | undefined
let queueEntries: QueueEntry[] = []

const redisExists = redis.exists.bind(redis)
const redisSet = redis.set.bind(redis)
const settingsGet = settings.get.bind(settings)
const redditSubmitPost = reddit.submitPost.bind(reddit)
const globalFetch = globalThis.fetch

before(async () => {
  redis.exists = (async (...keys: string[]) =>
    keys.filter(key => redisValues.has(key)).length) as typeof redis.exists

  redis.set = (async (key: string, value: string) => {
    redisValues.set(key, value)
    return value
  }) as typeof redis.set

  settings.get = (async (name: string) =>
    name === 'queueUrl' ? queueUrl : undefined) as typeof settings.get

  reddit.submitPost = (async opts => {
    const id = `t3_${submittedPosts.length + 1}`
    submittedPosts.push({
      title: opts.title,
      url: 'url' in opts ? opts.url : undefined,
    })
    return {
      id,
      url: `https://reddit.com/r/soyapptest_dev/comments/${id}`,
      addComment: async (commentOpts: {text: string}) => {
        comments.push({postId: id, text: commentOpts.text})
        return {} as unknown
      },
    } as unknown as Post
  }) as typeof reddit.submitPost

  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url === QUEUE_URL) {
      return new Response(JSON.stringify(queueEntries), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      })
    }
    return globalFetch(input, init)
  }) as typeof fetch

  server = createServer(async (req, rsp) => {
    await runWithContext(
      {
        appName: 'soyapptest',
        subredditId: 't5_123',
        subredditName: 'soyapptest_dev',
        userId: 't2_123',
        username: 'username',
      } as unknown as Context,
      () => onReq(req, rsp),
    )
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const info = server.address() as AddressInfo
  serverURL = `http://127.0.0.1:${info.port}`
})

after(async () => {
  redis.exists = redisExists
  redis.set = redisSet
  settings.get = settingsGet
  reddit.submitPost = redditSubmitPost
  globalThis.fetch = globalFetch
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
  })
})

beforeEach(() => {
  redisValues.clear()
  submittedPosts = []
  comments = []
  queueUrl = QUEUE_URL
  queueEntries = []
})

test('does nothing when the queue URL is unset', async () => {
  queueUrl = undefined
  queueEntries = [
    {
      videoId: 'abc123',
      subreddit: 'soyapptest_dev',
      title: 'A video [creator-summarized]',
      summary: 'A summary.',
      flag: 'creator-summarized',
    },
  ]

  const rsp = await fetch(`${serverURL}/${Endpoint.OnSchedulePostVideo}`, {
    method: 'POST',
  })
  assert.equal(rsp.status, 200)
  assert.equal(submittedPosts.length, 0)
})

test('skips entries for a different subreddit', async () => {
  queueEntries = [
    {
      videoId: 'abc123',
      subreddit: 'some_other_subreddit',
      title: 'A video [creator-summarized]',
      summary: 'A summary.',
      flag: 'creator-summarized',
    },
  ]

  const rsp = await fetch(`${serverURL}/${Endpoint.OnSchedulePostVideo}`, {
    method: 'POST',
  })
  assert.equal(rsp.status, 200)
  assert.equal(submittedPosts.length, 0)
})

test('skips videos already posted', async () => {
  redisValues.set('posted:abc123', '1')
  queueEntries = [
    {
      videoId: 'abc123',
      subreddit: 'soyapptest_dev',
      title: 'A video [creator-summarized]',
      summary: 'A summary.',
      flag: 'creator-summarized',
    },
  ]

  const rsp = await fetch(`${serverURL}/${Endpoint.OnSchedulePostVideo}`, {
    method: 'POST',
  })
  assert.equal(rsp.status, 200)
  assert.equal(submittedPosts.length, 0)
})

test('posts new videos and comments with the summary', async () => {
  queueEntries = [
    {
      videoId: 'abc123',
      subreddit: 'soyapptest_dev',
      title: 'A video [creator-summarized]',
      summary: 'A summary.',
      flag: 'creator-summarized',
    },
  ]

  const rsp = await fetch(`${serverURL}/${Endpoint.OnSchedulePostVideo}`, {
    method: 'POST',
  })
  assert.equal(rsp.status, 200)
  assert.equal(submittedPosts.length, 1)
  assert.deepEqual(submittedPosts[0], {
    title: 'A video [creator-summarized]',
    url: 'https://www.youtube.com/watch?v=abc123',
  })
  assert.equal(comments.length, 1)
  assert.equal(comments[0]?.text, 'A summary.')
  assert.equal(redisValues.get('posted:abc123'), '1')
})

test('menu sync reports how many videos were posted', async () => {
  queueEntries = [
    {
      videoId: 'abc123',
      subreddit: 'soyapptest_dev',
      title: 'A video [creator-summarized]',
      summary: 'A summary.',
      flag: 'creator-summarized',
    },
  ]

  const rsp = await fetch(`${serverURL}/${Endpoint.OnMenuNewPost}`, {
    method: 'POST',
  })
  assert.equal(rsp.status, 200)
  assert.equal(rsp.headers.get('Content-Type'), 'application/json')
  const body = (await rsp.json()) as {showToast: {text: string}}
  assert.equal(body.showToast.text, 'Posted 1 new video.')
})

test('wrong method', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.OnAppInstall}`)
  assert.equal(rsp.status, 404)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'not found',
    status: 404,
  })
})

test('404', async () => {
  const rsp = await fetch(serverURL)
  assert.equal(rsp.status, 404)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'not found',
    status: 404,
  })
})
