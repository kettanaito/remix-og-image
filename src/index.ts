export const OPEN_GRAPH_USER_AGENT_HEADER = 'vite-remix-og-image-plugin'

export interface OpenGraphImageData {
  name: string
  params: Record<string, string>
}

export function isOpenGraphImageRequest(request: Request): boolean {
  return request.headers.get('user-agent') === OPEN_GRAPH_USER_AGENT_HEADER
}
