/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** One video queued by the soybot pipeline, read from `queue.json`. */
export type QueueEntry = {
  videoId: string
  subreddit: string
  title: string
  summary: string
  flag: 'creator-summarized' | 'soybot-summarized'
}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnSchedulePostVideo: 'internal/on/schedule/post-video',
} as const

export const EndpointMethod = {
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnSchedulePostVideo]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
