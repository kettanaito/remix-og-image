export const OPEN_GRAPH_USER_AGENT_HEADER = 'remix-og-image'

export interface OpenGraphImageData {
  name: string
  params?: Record<string, string>
}

export function isOpenGraphImageRequest(request: Request): boolean {
  return request.headers.get('user-agent') === OPEN_GRAPH_USER_AGENT_HEADER
}
