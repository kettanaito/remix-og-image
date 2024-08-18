import fs from 'node:fs'
import path from 'node:path'
import {
  type Plugin,
  type ResolvedConfig,
  type ViteDevServer,
  createServer,
  resolveConfig,
  normalizePath,
} from 'vite'
import { parse as esModuleLexer } from 'es-module-lexer'
import sharp from 'sharp'
import type { ResolvedRemixConfig } from '@remix-run/dev'
import type { ConfigRoute } from '@remix-run/dev/dist/config/routes.js'
import { DeferredPromise } from '@open-draft/deferred-promise'
import {
  deadCodeElimination,
  findReferencedIdentifiers,
} from 'babel-dead-code-elimination'
import { compile } from 'path-to-regexp'
import { Browser, launch } from 'puppeteer'
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
   * Directory to output the generated images.
   * This is likely somewhere in your `public` directory.
   */
  outputDirectory: string

  /**
   * Format of the generated image.
   * @default "jpeg"
   */
  format?: 'jpeg' | 'png' | 'webp'

  writeImage?: (args: { image: File }) => Promise<void>
}

interface RemixPluginContext {
  remixConfig: ResolvedRemixConfig
}

interface GeneratedOpenGraphImage {
  name: string
  path: string
  content: Uint8Array
}

interface CacheEntry {
  routeLastModifiedAt: number
  imagePaths: Array<string>
}

const PLUGIN_NAME = 'remix-og-image-plugin'
const EXPORT_NAME = 'openGraphImage'
const CACHE_FILE = 'node_modules/.vite/cache/remix-og-image/cache.json'

export function openGraphImagePlugin(options: Options): Plugin {
  const format = options.format || 'jpeg'

  const cache = new Cache<string, CacheEntry>()
  const viteConfigPromise = new DeferredPromise<ResolvedConfig>()
  const remixContextPromise = new DeferredPromise<RemixPluginContext>()
  const serverUrlPromise = new DeferredPromise<URL>()
  const routesWithImages = new Set<ConfigRoute>()

  async function fromRoot(...paths: Array<string>): Promise<string> {
    const viteConfig = await viteConfigPromise
    return path.resolve(viteConfig.root, ...paths)
  }

  async function fromRemixApp(...paths: Array<string>): Promise<string> {
    const remixContext = await remixContextPromise
    return path.resolve(remixContext.remixConfig.appDirectory, ...paths)
  }

  async function fromOutputDirectory(...paths: Array<string>): Promise<string> {
    return fromRoot(options.outputDirectory, ...paths)
  }

  async function generateOpenGraphImages(
    route: ConfigRoute,
    browser: Browser,
    serverUrl: URL
  ): Promise<Array<GeneratedOpenGraphImage>> {
    if (!route.path) {
      return []
    }

    // See if the route already has images generated in the cache.
    const cacheEntry = cache.get(route.id)
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
      const allImagesExist = () => {
        return (
          cacheEntry.imagePaths.length > 0 &&
          cacheEntry.imagePaths.every((imagePath) => {
            return fs.existsSync(imagePath)
          })
        )
      }

      // Skip generating the images only if the route module hasn't changed
      // and all the previously generated images still exist.
      if (!hasRouteChanged && allImagesExist()) {
        return []
      }
    }

    const createRoutePath = compile(route.path)
    const resourceUrl = new URL(route.path, serverUrl)
    // Set the "_data" search parameter so the route can be queried
    // like a resource route although it renders UI.
    resourceUrl.searchParams.set('_data', route.id)

    // Fetch all the params data from the route.
    const dataResponse = await fetch(resourceUrl, {
      headers: {
        'user-agent': OPEN_GRAPH_USER_AGENT_HEADER,
      },
    }).catch((error) => {
      throw new Error(
        `Failed to fetch Open Graph image data for route "${route.id}": ${error}`
      )
    })

    if (!dataResponse.ok) {
      throw new Error(
        `Failed to fetch Open Graph image data for route "${route.id}": loader responsed with ${dataResponse.status}`
      )
    }

    const responseContentType = dataResponse.headers.get('content-type') || ''
    if (!responseContentType.includes('application/json')) {
      throw new Error(
        `Failed to fetch Open Graph image data for route "${route.id}": loader responsed with invalid content type ("${responseContentType}"). Did you forget to throw \`json(openGraphImage())\` in your loader?`
      )
    }

    const allData = (await dataResponse.json()) as Array<OpenGraphImageData>

    if (!Array.isArray(allData)) {
      throw new Error(
        `Failed to fetch Open Graph image data for route "${route.id}": loader responded with invalid response. Did you forget to throw \`json(openGraphImage())\` in your loader?`
      )
    }

    /**
     * @todo Improve error handling:
     * - OG route forgetting to return the data;
     * - OG route returning invalid data;
     */

    const images: Array<GeneratedOpenGraphImage> = []

    await Promise.all(
      allData.map(async (data) => {
        const page = await browser.newPage()

        try {
          const pageUrl = new URL(createRoutePath(data.params), serverUrl).href
          await page.goto(pageUrl, { waitUntil: 'networkidle0' })

          // Set viewport to a 5K device equivalent.
          // This is more than enough to ensure that the OG image is visible.
          await page.setViewport({
            width: 5120,
            height: 2880,
            // Use a larger scale factor to get a crisp image.
            deviceScaleFactor: 2,
          })

          const ogImageBoundingBox = await page
            .$(options.elementSelector)
            .then((element) => element?.boundingBox())

          if (!ogImageBoundingBox) {
            return []
          }

          await page.evaluate((selector) => {
            const element = document.querySelector(selector)
            if (element) {
              element.scrollIntoView(true)
            }
          }, options.elementSelector)

          const imageBuffer = await page.screenshot({
            type: format,
            quality: 100,
            encoding: 'binary',
            // Set an explicit `clip` boundary for the screenshot
            // to capture only the image and ignore any otherwise
            // present UI, like the layout.
            clip: ogImageBoundingBox,
          })

          const optimizedImageBuffer = await sharp(imageBuffer)
            .resize({
              // Resize the image to the original DOM element's size.
              // This compensates for the device scale factor.
              width: ogImageBoundingBox.width,
            })
            .png({
              compressionLevel: 9,
              adaptiveFiltering: true,
            })
            .toBuffer()

          const imageName = `${data.name}.${format}`

          images.push({
            name: imageName,
            path: await fromOutputDirectory(imageName),
            content: optimizedImageBuffer,
          })
        } finally {
          await page.close({ runBeforeUnload: false })
        }
      })
    )

    cache.set(route.id, {
      routeLastModifiedAt,
      imagePaths: images.map((image) => image.path),
    })

    return images
  }

  async function writeImage(image: GeneratedOpenGraphImage) {
    if (options.writeImage) {
      return await options.writeImage({
        image: new File([image.content], image.path),
      })
    }

    const directoryName = path.dirname(image.path)
    if (!fs.existsSync(directoryName)) {
      await fs.promises.mkdir(directoryName, { recursive: true })
    }
    await fs.promises.writeFile(image.path, image.content)
  }

  return {
    name: PLUGIN_NAME,

    async buildStart() {
      const viteConfig = await viteConfigPromise
      await cache.open(path.resolve(viteConfig.root, CACHE_FILE))
    },

    configResolved(config) {
      viteConfigPromise.resolve(config)
      /**
       * @todo Would be nice for Remix to expose this internal key.
       */
      remixContextPromise.resolve(Reflect.get(config, '__remixPluginContext'))
    },

    async configureServer(server) {
      const viteConfig = await viteConfigPromise

      if (viteConfig.command === 'build') {
        return
      }

      const { httpServer } = server

      if (!httpServer) {
        return
      }

      // In serve mode, listen to the existing preview server.
      httpServer.once('listening', async () => {
        const address = httpServer.address()

        if (!address) {
          return
        }

        const url =
          typeof address === 'string'
            ? address
            : `http://localhost:${address.port}`

        serverUrlPromise.resolve(new URL(url))
      })
    },

    async transform(code, id, options = {}) {
      const viteConfig = await viteConfigPromise
      const remixContext = await remixContextPromise

      if (!remixContext) {
        return
      }

      const routePath = normalizePath(
        path.relative(remixContext.remixConfig.appDirectory, id)
      )
      const route = Object.values(remixContext.remixConfig.routes).find(
        (route) => {
          return normalizePath(route.file) === routePath
        }
      )

      // Ignore non-route modules.
      if (!route) {
        return
      }

      const [, routeExports] = esModuleLexer(code)

      // Ignore routes that don't have the root-level special export.
      const ogImageExport = routeExports.find((e) => e.n === EXPORT_NAME)

      if (!ogImageExport) {
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

      // In serve mode, generate images alongside the changes to routes.
      if (viteConfig.command === 'serve' && !viteConfig.isProduction) {
        const serverUrl = await serverUrlPromise

        // Don't await the generation promise, let it run in the background.
        generateOpenGraphImages(
          route,
          await getBrowserInstance(),
          serverUrl
        ).then((images) => images.map(writeImage))
      }

      routesWithImages.add(route)
    },

    async handleHotUpdate(ctx) {
      /**
       * @fixme Vite reports HMR on emitted OG images in the public directory.
       * Maybe make it ignore them here somehow?
       */

      const importerPaths = ctx.modules
        .flatMap((affectedModules) => {
          return Array.from(affectedModules.importers)
        })
        .map((importer) => importer.file)
        .filter<string>((importerPath) => typeof importerPath === 'string')

      // If any of the modules affected by HMR include the OG routes,
      // re-generate the OG images for those routes. This way,
      // changes to OG route's dependencies update the images.
      const affectedRoutes: Array<ConfigRoute> = []
      for (const route of routesWithImages) {
        if (importerPaths.includes(await fromRemixApp(route.file))) {
          affectedRoutes.push(route)
        }
      }

      if (affectedRoutes.length > 0) {
        const serverUrl = await serverUrlPromise

        for (const route of affectedRoutes) {
          // Clear this route's cache to force image generation.
          cache.delete(route.id)

          generateOpenGraphImages(
            route,
            await getBrowserInstance(),
            serverUrl
          ).then((images) => images.map(writeImage))
        }
      }
    },

    // Use `writeBundle` and not `closeBundle` so the image generation
    // time is counted toward the total build time.
    writeBundle: {
      order: 'post',
      async handler() {
        const viteConfig = await viteConfigPromise

        if (
          viteConfig.command === 'build' &&
          /**
           * @fixme This is a hacky way of knowing the build end.
           * The problem is that `closeBundle` will trigger MULTIPLE times,
           * as there are multiple bundles Remix builds (client, server, etc).
           * This plugin has to run after the LASTMOST bundle.
           */
          viteConfig.build.rollupOptions.input ===
            'virtual:remix/server-build' &&
          routesWithImages.size > 0
        ) {
          console.log(
            'Generating OG images for %d route(s)...',
            routesWithImages.size
          )

          const [browser, server] = await Promise.all([
            getBrowserInstance(),

            /**
             * @fixme Vite preview server someties throws:
             * "Error: The server is being restarted or closed. Request is outdated."
             * when trying to navigate to it. It requires a refresh to work.
             */
            runVitePreviewServer(viteConfig),
          ])
          const serverUrl = new URL(server.resolvedUrls?.local?.[0]!)

          const pendingScreenshots = Array.from(routesWithImages).map(
            (route) => {
              return generateOpenGraphImages(route, browser, serverUrl)
                .then((images) => images.map(writeImage))
                .catch((error) => {
                  this.error(
                    `Failed to generate OG image for route "${route.id}": ${error}`
                  )
                })
            }
          )

          await Promise.allSettled(pendingScreenshots)
          await Promise.all([server.close(), browser.close(), cache.close()])
        }
      },
    },
  }
}

let browser: Browser | undefined

async function getBrowserInstance(): Promise<Browser> {
  if (browser) {
    return browser
  }

  browser = await launch({ headless: true })
  return browser
}

async function runVitePreviewServer(
  viteConfig: ResolvedConfig
): Promise<ViteDevServer> {
  /**
   * @note Force `NODE_ENV` to be "development" for the preview server.
   * Vite sets certain internal flags based on the environment, and there
   * is no way to override that. The build is triggered with "production",
   * but the preview server MUST be "development". This also makes sure
   * that all the used plugins are instantiated correctly.
   */
  process.env.NODE_ENV = 'development'

  // Use the `resolveConfig` function explicitly because it
  // allows passing options like `command` and `mode` to Vite.
  const previewViteConfig = await resolveConfig(
    {
      root: viteConfig.root,
      configFile: viteConfig.configFile,
      /**
       * @fixme Despite the log levels, this server stills prints
       * "Using vars defined in XYZ" when run. Is there a way to turn that off?
       */
      logLevel: 'error',
    },
    'serve',
    // Using `production` mode is important.
    // It will skip all the built-in development-oriented plugins in Vite.
    'production',
    'development',
    false
  )

  const server = await createServer(previewViteConfig.inlineConfig)
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
    await fs.promises.writeFile(this.cachePath, cacheContent, 'utf8')
  }
}
