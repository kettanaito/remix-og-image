import fs from 'node:fs'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
  createServer,
  resolveConfig,
  normalizePath,
} from 'vite'
import { parse as esModuleLexer } from 'es-module-lexer'
import { decode } from 'turbo-stream'
import sharp from 'sharp'
import type { VitePluginConfig as RemixVitePluginConfig } from '@remix-run/dev'
import type { RouteConfigEntry } from '@remix-run/dev/dist/config/routes.js'
import { DeferredPromise } from '@open-draft/deferred-promise'
import {
  deadCodeElimination,
  findReferencedIdentifiers,
} from 'babel-dead-code-elimination'
import { compile } from 'path-to-regexp'
import { type Browser, type Page, chromium } from 'playwright'
import { performance } from './performance.js'
import { parse, traverse, generate, t } from './babel.js'
import {
  OPEN_GRAPH_USER_AGENT_HEADER,
  type OpenGraphImageData,
} from './index.js'

interface Options {
  /**
   * Selector for the element to capture as the Open Graph image.
   * @example "#og-image"
   */
  elementSelector: string

  /**
   * Relative path to the directory to store generated images.
   * Relative to the client build assets (e.g. `/build/client`).
   */
  outputDirectory: string

  /**
   * Path to the debug directory to store any error-related screenshots.
   */
  debugDirectory?: string

  /**
   * Format of the generated image.
   * @default "jpeg"
   */
  format?: 'jpeg' | 'png' | 'webp'

  writeImage?: (image: { stream: Readable }) => Promise<void>

  browser?: {
    executablePath?: string

    /**
     * Custom media features.
     * Use this to force media features like `prefers-color-scheme`
     * or `prefers-reduced-motion`.
     *
     * @example
     * mediaFeatures: {
     *   'prefers-color-scheme': 'dark',
     * }
     */
    mediaFeatures?: Parameters<Page['emulateMedia']>[0]
  }
}

interface RemixPluginContext {
  remixConfig: Required<RemixVitePluginConfig>
  useSingleFetch: boolean
}

interface GeneratedOpenGraphImage {
  name: string
  path: string
  stream: Readable
}

interface CacheEntry {
  routeLastModifiedAt: number
  images: Array<{
    name: string
    outputPath: string
  }>
}

const PLUGIN_NAME = 'remix-og-image-plugin'
const EXPORT_NAME = 'openGraphImage'
const CACHE_DIR = path.resolve('node_modules/.cache/remix-og-image')
const CACHE_MANIFEST = path.resolve(CACHE_DIR, 'manifest.json')
const CACHE_RESULTS_DIR = path.resolve(CACHE_DIR, 'output')

export function openGraphImage(options: Options): Plugin {
  if (path.isAbsolute(options.outputDirectory)) {
    throw new Error(
      `Failed to initialize plugin: expected "outputDirectory" to be a relative path but got "${options.outputDirectory}". Please make sure it starts with "./".`,
    )
  }

  const format = options.format || 'jpeg'

  const cache = new Cache<string, CacheEntry>()
  const browserPromise = new DeferredPromise<Browser>()
  const vitePreviewPromise = new DeferredPromise<ViteDevServer>()
  const viteConfigPromise = new DeferredPromise<ResolvedConfig>()
  const remixContextPromise = new DeferredPromise<RemixPluginContext>()
  const routesWithImages = new Set<RouteConfigEntry>()

  async function fromRemixApp(...paths: Array<string>): Promise<string> {
    const remixContext = await remixContextPromise
    return path.resolve(remixContext.remixConfig.appDirectory, ...paths)
  }

  async function fromViteBuild(...paths: Array<string>): Promise<string> {
    const remixContext = await remixContextPromise
    return path.resolve(
      remixContext.remixConfig.buildDirectory,
      'client',
      ...paths,
    )
  }

  async function fromOutputDirectory(...paths: Array<string>): Promise<string> {
    return fromViteBuild(options.outputDirectory, ...paths)
  }

  async function generateOpenGraphImages(
    route: RouteConfigEntry,
    browser: Browser,
    appUrl: URL,
  ): Promise<Array<GeneratedOpenGraphImage>> {
    if (!route.path) {
      return []
    }

    performance.mark(`generate-image-${route.file}-start`)

    // See if the route already has images generated in the cache.
    const cacheEntry = cache.get(route.file)
    const routeStats = await fs.promises
      .stat(await fromRemixApp(route.file))
      .catch((error) => {
        console.log('Failed to read stats for route "%s"', route.file, error)
        throw error
      })
    const routeLastModifiedAt = routeStats.mtimeMs

    if (cacheEntry) {
      const hasRouteChanged =
        routeLastModifiedAt > cacheEntry.routeLastModifiedAt

      // If the route hasn't changed, and there are cached generated results,
      // copy the generated images without spawning the browser, screenshoting, etc.
      if (!hasRouteChanged) {
        await Promise.all(
          cacheEntry.images.map((cachedImage) => {
            const cachedImagePath = path.resolve(
              CACHE_RESULTS_DIR,
              cachedImage.name,
            )

            if (fs.existsSync(cachedImagePath)) {
              return writeImage({
                name: cachedImage.name,
                path: cachedImage.outputPath,
                stream: fs.createReadStream(cachedImagePath),
              })
            }
          }),
        )

        /**
         * @fixme If copying the cached images fails for any reason,
         * the plugin should continue ONLY with the sub-list of images
         * that excludes those that were successfully copied from the cache.
         */
        return []
      }
    }

    const remixContext = await remixContextPromise
    const createRoutePath = compile(route.path)

    performance.mark(`generate-image-${route.id}-loader-start`)

    // Fetch all the params data from the route.
    const loaderData = await getLoaderData(
      route,
      appUrl,
      remixContext.useSingleFetch,
    )

    performance.mark(`generate-image-${route.id}-loader-end`)
    performance.measure(
      `generate-image-${route.id}:loader`,
      `generate-image-${route.id}-loader-start`,
      `generate-image-${route.id}-loader-end`,
    )

    const images: Array<GeneratedOpenGraphImage> = []

    await Promise.all(
      loaderData.map(async (data) => {
        performance.mark(`generate-image-${route.id}-${data.name}-start`)

        performance.mark(
          `generate-image-${route.id}-${data.name}-new-page-start`,
        )

        const page = await browser.newPage({
          // Use a larger scale factor to get a crisp image.
          deviceScaleFactor: 2,
          // Set viewport to a 5K device equivalent.
          // This is more than enough to ensure that the OG image is visible.
          viewport: {
            width: 5120,
            height: 2880,
          },
        })

        // Support custom user preferences (media features),
        // such as forcing a light/dark mode for the app.
        const mediaFeatures = options.browser?.mediaFeatures
        if (mediaFeatures) {
          await page.emulateMedia(mediaFeatures)
        }

        performance.mark(`generate-image-${route.id}-${data.name}-new-page-end`)
        performance.measure(
          `generate-image-${route.id}-${data.name}:new-page`,
          `generate-image-${route.id}-${data.name}-new-page-start`,
          `generate-image-${route.id}-${data.name}-new-page-end`,
        )

        try {
          const pageUrl = new URL(createRoutePath(data.params), appUrl).href

          performance.mark(
            `generate-image-${route.id}-${data.name}-pageload-start`,
          )

          await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

          performance.mark(
            `generate-image-${route.id}-${data.name}-pageload-end`,
          )
          performance.measure(
            `generate-image-${route.id}-${data.name}:pageload`,
            `generate-image-${route.id}-${data.name}-pageload-start`,
            `generate-image-${route.id}-${data.name}-pageload-end`,
          )

          const element = page.locator(options.elementSelector)

          await element.waitFor({ state: 'visible' }).catch(async (error) => {
            console.log(
              'failed to generate OG image for "%s": OG image element not found',
              data.name,
            )

            if (options.debugDirectory) {
              const debugScreenshotBuffer = await page.screenshot({
                type: 'png',
              })
              await fs.promises.writeFile(
                path.join(
                  options.debugDirectory,
                  `${data.name}-element-not-visible.png`,
                ),
                debugScreenshotBuffer,
              )
            }

            throw error
          })

          const ogImageBoundingBox = await element.boundingBox()

          if (!ogImageBoundingBox) {
            console.log(
              'failed to generate OG image for "%s": cannot calculate the bounding box',
              data.name,
            )

            if (options.debugDirectory) {
              const debugScreenshotBuffer = await page.screenshot({
                type: 'png',
              })
              await fs.promises.writeFile(
                path.join(
                  options.debugDirectory,
                  `${data.name}-element-no-bounding-box.png`,
                ),
                debugScreenshotBuffer,
              )
            }

            return []
          }

          performance.mark(
            `generate-image-${route.id}-${data.name}-screenshot-start`,
          )

          const imageBuffer = await page.screenshot({
            // Always take screenshots as png.
            // This allows for initial transparency. The end image format
            // will be decided by `sharp` later.
            type: 'png',
            // Set an explicit `clip` boundary for the screenshot
            // to capture only the image and ignore any otherwise
            // present UI, like the layout.
            clip: ogImageBoundingBox,
          })

          performance.mark(
            `generate-image-${route.id}-${data.name}-screenshot-end`,
          )
          performance.measure(
            `generate-image-${route.id}-${data.name}:screenshot`,
            `generate-image-${route.id}-${data.name}-screenshot-start`,
            `generate-image-${route.id}-${data.name}-screenshot-end`,
          )

          let imageStream = sharp(imageBuffer)

          switch (format) {
            case 'jpeg': {
              imageStream = imageStream.jpeg({
                quality: 100,
                progressive: true,
              })
              break
            }

            case 'png': {
              imageStream = imageStream.png({
                compressionLevel: 9,
                adaptiveFiltering: true,
              })
              break
            }

            case 'webp': {
              imageStream = imageStream.webp({
                lossless: true,
                smartSubsample: true,
                quality: 100,
                preset: 'picture',
              })
              break
            }
          }

          const imageName = `${data.name}.${format}`

          images.push({
            name: imageName,
            path: await fromOutputDirectory(imageName),
            stream: imageStream,
          })
        } finally {
          await page.close({ runBeforeUnload: false })

          performance.mark(`generate-image-${route.id}-${data.name}-end`)
          performance.measure(
            `generate-image-${route.id}-${data.name}`,
            `generate-image-${route.id}-${data.name}-start`,
            `generate-image-${route.id}-${data.name}-end`,
          )
        }
      }),
    )

    performance.mark(`generate-image-${route.id}-end`)
    performance.measure(
      `generate-image-${route.id}`,
      `generate-image-${route.id}-start`,
      `generate-image-${route.id}-end`,
    )

    cache.set(route.file, {
      routeLastModifiedAt,
      images: images.map((image) => ({
        name: image.name,
        outputPath: image.path,
      })),
    })

    return images
  }

  async function writeImage(image: GeneratedOpenGraphImage) {
    if (options.writeImage) {
      return await options.writeImage({
        stream: image.stream,
      })
    }

    const directoryName = path.dirname(image.path)
    await Promise.all([
      ensureDirectory(CACHE_RESULTS_DIR),
      ensureDirectory(directoryName),
    ])
    await ensureDirectory(directoryName)

    const passthrough = new PassThrough()
    const destWriteStream = fs.createWriteStream(image.path)
    const cacheWriteStream = fs.createWriteStream(
      path.resolve(CACHE_RESULTS_DIR, image.name),
    )

    image.stream.pipe(passthrough)
    passthrough.pipe(destWriteStream)
    passthrough.pipe(cacheWriteStream)

    await Promise.all([finished(destWriteStream), finished(cacheWriteStream)])

    console.log(`Generated OG image at "${image.path}".`)
  }

  performance.mark('plugin-start')

  return {
    name: PLUGIN_NAME,

    apply: 'build',

    async buildStart() {
      const viteConfig = await viteConfigPromise
      await cache.open(path.resolve(viteConfig.root, CACHE_MANIFEST))
    },

    configResolved(config) {
      viteConfigPromise.resolve(config)

      const reactRouterContext = Reflect.get(
        config,
        '__reactRouterPluginContext',
      )

      // react-router
      if (reactRouterContext) {
        remixContextPromise.resolve({
          remixConfig: reactRouterContext.reactRouterConfig,
          useSingleFetch: true,
        })
        return
      }

      const remixContext = Reflect.get(config, '__remixPluginContext')

      if (typeof remixContext === 'undefined') {
        throw new Error(
          `Failed to apply "remix-og-image" plugin: no Remix context found. Did you forget to use the Remix plugin in your Vite configuration?`,
        )
      }

      remixContextPromise.resolve({
        remixConfig: remixContext.remixConfig,
        useSingleFetch:
          !!Reflect.get(
            remixContext.remixConfig.future,
            'unstable_singleFetch',
          ) || !!Reflect.get(remixContext.remixConfig.future, 'v3_singleFetch'),
      })
    },

    async transform(code, id, options = {}) {
      const remixContext = await remixContextPromise

      if (!remixContext) {
        return
      }

      const routePath = normalizePath(
        path.relative(remixContext.remixConfig.appDirectory, id),
      )
      const route = Object.values(remixContext.remixConfig.routes).find(
        (route) => {
          return normalizePath(route.file) === routePath
        },
      )

      // Ignore non-route modules.
      if (!route) {
        return
      }

      const [, routeExports] = esModuleLexer(code)

      // Ignore routes that don't have the root-level special export.
      const hasSpecialExport =
        routeExports.findIndex((e) => e.n === EXPORT_NAME) !== -1

      if (!hasSpecialExport) {
        return
      }

      // OG image generation must only happen server-side.
      if (!options.ssr) {
        // Parse the route module and remove the special export altogether.
        // This way, it won't be present in the client bundle, and won't affect
        // "vite-plugin-react" and its HMR.
        const ast = parse(code, { sourceType: 'module' })
        const refs = findReferencedIdentifiers(ast)

        traverse(ast, {
          ExportNamedDeclaration(path) {
            if (
              t.isFunctionDeclaration(path.node.declaration) &&
              t.isIdentifier(path.node.declaration.id) &&
              path.node.declaration.id.name === EXPORT_NAME
            ) {
              path.remove()
            }
          },
        })

        // Use DCE to remove any references the special export might have had.
        deadCodeElimination(ast, refs)
        return generate(ast, { sourceMaps: true, sourceFileName: id }, code)
      }

      // Spawn the browser immediately once we detect an OG image route.
      if (routesWithImages.size === 0) {
        browserPromise.resolve(getBrowserInstance())
        vitePreviewPromise.resolve(
          runVitePreviewServer(await viteConfigPromise),
        )
      }

      routesWithImages.add(route)
    },

    // Use `writeBundle` and not `closeBundle` so the image generation
    // time is counted toward the total build time.
    writeBundle: {
      order: 'post',
      async handler() {
        const viteConfig = await viteConfigPromise
        const isBuild = viteConfig.command === 'build'
        const isServerBuild =
          viteConfig.build.rollupOptions.input ===
            'virtual:remix/server-build' ||
          // react-router
          viteConfig.build.rollupOptions.input ===
            'virtual:react-router/server-build'

        if (
          isBuild &&
          /**
           * @fixme This is a hacky way of knowing the build end.
           * The problem is that `closeBundle` will trigger MULTIPLE times,
           * as there are multiple bundles Remix builds (client, server, etc).
           * This plugin has to run after the LASTMOST bundle.
           */
          isServerBuild
        ) {
          console.log(
            `Generating OG images for ${routesWithImages.size} route(s):
${Array.from(routesWithImages)
  .map((route) => `  - ${route.id}`)
  .join('\n')}
            `,
          )

          const [browser, server] = await Promise.all([
            browserPromise,

            /**
             * @fixme Vite preview server someties throws:
             * "Error: The server is being restarted or closed. Request is outdated."
             * when trying to navigate to it. It requires a refresh to work.
             */
            vitePreviewPromise,
          ])
          const appUrl = new URL(server.resolvedUrls?.local?.[0]!)
          const pendingScreenshots: Array<Promise<unknown>> = []

          for (const route of routesWithImages) {
            pendingScreenshots.push(
              generateOpenGraphImages(route, browser, appUrl)
                .then((images) => Promise.all(images.map(writeImage)))
                .catch((error) => {
                  throw new Error(
                    `Failed to generate OG image for route "${route.id}".`,
                    { cause: error },
                  )
                }),
            )
          }

          const results = await Promise.allSettled(pendingScreenshots)
          await Promise.all([server.close(), browser.close(), cache.close()])

          let hasErrors = false
          results.forEach((result) => {
            if (result.status === 'rejected') {
              hasErrors = true
              console.error(result.reason)
            }
          })

          if (hasErrors) {
            throw new Error(
              'Failed to generate OG images. Please see the errors above.',
            )
          }

          performance.mark('plugin-end')
          performance.measure('plugin', 'plugin-start', 'plugin-end')
        }
      },
    },
  }
}

let browser: Browser | undefined

async function getBrowserInstance(
  options: Options['browser'] = {},
): Promise<Browser> {
  if (browser) {
    return browser
  }

  performance.mark('browser-launch-start')

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
    executablePath: options.executablePath || chromium.executablePath(),
  })

  performance.mark('browser-launch-end')
  performance.measure(
    'browser-launch',
    'browser-launch-start',
    'browser-launch-end',
  )

  return browser
}

async function runVitePreviewServer(
  viteConfig: ResolvedConfig,
): Promise<ViteDevServer> {
  /**
   * @note Force `NODE_ENV` to be "development" for the preview server.
   * Vite sets certain internal flags based on the environment, and there
   * is no way to override that. The build is triggered with "production",
   * but the preview server MUST be "development". This also makes sure
   * that all the used plugins are instantiated correctly.
   */
  process.env.NODE_ENV = 'development'

  performance.mark('vite-preview-resolve-config-start')

  // Use the `resolveConfig` function explicitly because it
  // allows passing options like `command` and `mode` to Vite.
  const previewViteConfig = await resolveConfig(
    {
      root: viteConfig.root,
      configFile: viteConfig.configFile,
      logLevel: 'error',
    },
    'serve',
    // Using `production` mode is important.
    // It will skip all the built-in development-oriented plugins in Vite.
    'production',
    'development',
    false,
  )

  performance.mark('vite-preview-resolve-config-end')
  performance.measure(
    'vite-preview-resolve-config',
    'vite-preview-resolve-config-start',
    'vite-preview-resolve-config-end',
  )

  performance.mark('vite-preview-server-start')

  const server = await createServer(previewViteConfig.inlineConfig)

  performance.mark('vite-preview-server-end')
  performance.measure(
    'vite-preview-server',
    'vite-preview-server-start',
    'vite-preview-server-end',
  )

  return server.listen()
}

class Cache<K, V> extends Map<K, V> {
  private cachePath?: string

  constructor() {
    super()
  }

  public async open(cachePath: string): Promise<void> {
    if (this.cachePath) {
      return
    }

    this.cachePath = cachePath

    if (fs.existsSync(this.cachePath)) {
      const cacheContent = await fs.promises
        .readFile(this.cachePath, 'utf-8')
        .then(JSON.parse)
        .catch(() => ({}))

      for (const [key, value] of Object.entries(cacheContent)) {
        this.set(key as K, value as V)
      }
    }
  }

  public async close(): Promise<void> {
    if (!this.cachePath) {
      throw new Error(`Failed to close cache: cache is not open`)
    }

    const cacheContent = JSON.stringify(Object.fromEntries(this.entries()))
    const baseDirectory = path.dirname(this.cachePath)
    if (!fs.existsSync(baseDirectory)) {
      await fs.promises.mkdir(baseDirectory, { recursive: true })
    }
    return fs.promises.writeFile(this.cachePath, cacheContent, 'utf8')
  }
}

async function getLoaderData(
  route: RouteConfigEntry,
  appUrl: URL,
  useSingleFetch?: boolean,
) {
  const url = createResourceRouteUrl(route, appUrl, useSingleFetch)
  const response = await fetch(url, {
    headers: {
      'user-agent': OPEN_GRAPH_USER_AGENT_HEADER,
    },
  }).catch((error) => {
    throw new Error(
      `Failed to fetch Open Graph image data for route "${url.href}": ${error}`,
    )
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Open Graph image data for route "${url.href}": loader responsed with ${response.status}`,
    )
  }

  if (!response.body) {
    throw new Error(
      `Failed to fetch Open Graph image data for route "${url.href}": loader responsed with no body. Did you forget to throw \`json(openGraphImage())\` in your loader?`,
    )
  }

  const responseContentType = response.headers.get('content-type') || ''
  const expectedContentTypes = useSingleFetch
    ? ['text/x-turbo', 'text/x-script']
    : ['application/json']

  if (!expectedContentTypes.includes(responseContentType)) {
    throw new Error(
      `Failed to fetch Open Graph image data for route "${url.href}": loader responsed with invalid content type ("${responseContentType}"). Did you forget to throw \`json(openGraphImage())\` in your loader?`,
    )
  }

  // Consume the loader response based on the fetch mode.
  const data = await consumeLoaderResponse(response, route, useSingleFetch)

  if (!Array.isArray(data)) {
    throw new Error(
      `Failed to fetch Open Graph image data for route "${url.href}": loader responded with invalid response. Did you forget to throw \`json(openGraphImage())\` in your loader?`,
    )
  }

  return data
}

/**
 * Create a URL for the given route so it can be queried
 * as a resource route. Respects Single fetch mode.
 */
function createResourceRouteUrl(
  route: RouteConfigEntry,
  appUrl: URL,
  useSingleFetch?: boolean,
) {
  if (!route.path) {
    throw new Error(
      `Failed to create resource route URL for route "${route.id}": route has no path`,
    )
  }

  const url = new URL(route.path, appUrl)

  if (useSingleFetch) {
    url.pathname += '.data'
    /**
     * @note The `_routes` parameter is meant for fetching multiple loader
     * data that match the route. It won't work if you have multiple different,
     * independent routes, so we still need to fetch the loader data in multiple requests.
     */
    url.searchParams.set('_route', route.id!)
  } else {
    // Set the "_data" search parameter so the route can be queried
    // like a resource route although it renders UI.
    url.searchParams.set('_data', route.id!)
  }

  return url
}

async function decodeTurboStreamResponse(
  response: Response,
): Promise<Record<string, { data: unknown }>> {
  if (!response.body) {
    throw new Error(
      `Failed to decode turbo-stream response: response has no body`,
    )
  }

  const bodyStream = await decode(response.body)
  await bodyStream.done

  const decodedBody = bodyStream.value as Record<string, { data: unknown }>
  if (!decodedBody) {
    throw new Error(`Failed to decode turbo-stream response`)
  }

  return decodedBody
}

async function consumeLoaderResponse(
  response: Response,
  route: RouteConfigEntry,
  useSingleFetch?: boolean,
): Promise<Array<OpenGraphImageData>> {
  if (!response.body) {
    throw new Error(`Failed to read loader response: response has no body`)
  }

  // If the app is using Single Fetch, decode the loader
  // payload properly using the `turbo-stream` package.
  if (useSingleFetch) {
    const decodedBody = await decodeTurboStreamResponse(response)
    const routePayload = decodedBody[route.id!]

    if (!routePayload) {
      throw new Error(
        `Failed to consume loader response for route "${route.id}": route not found in decoded response`,
      )
    }

    const data = (routePayload as any).data as Array<OpenGraphImageData>

    if (!data) {
      throw new Error(
        `Failed to consume loader response for route "${route.id}": route has no data`,
      )
    }

    return data
  }

  // If the app is using the legacy loader response,
  // read it as JSON (it's not encoded).
  return response.json()
}

async function ensureDirectory(directory: string): Promise<void> {
  if (fs.existsSync(directory)) {
    return
  }
  await fs.promises.mkdir(directory, { recursive: true })
}
