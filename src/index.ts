export interface OgImageData {
  name: string
  params: Record<string, string>
}

export function isOgImageRequest(request: Request): boolean {
  return request.headers.get('user-agent') === 'vite-remix-og-image-plugin'
}
