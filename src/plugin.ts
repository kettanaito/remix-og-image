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
}

interface RemixPluginContext {
  remixConfig: ResolvedRemixConfig
}

interface GeneratedOpenGraphImage {
  name: string
  content: Uint8Array
}

const PLUGIN_NAME = 'remix-og-image-plugin'
const EXPORT_NAME = 'openGraphImage'

export function openGraphImagePlugin(options: Options): Plugin {
  const format = options.format || 'jpeg'

  const viteConfigPromise = new DeferredPromise<ResolvedConfig>()
  const remixContextPromise = new DeferredPromise<RemixPluginContext>()
  const serverUrlPromise = new DeferredPromise<URL>()
  const routesWithImages = new Set<ConfigRoute>()

  async function getOutputDirectory() {
    const viteConfig = await viteConfigPromise

    return path.resolve(
      viteConfig.root || process.cwd(),
      options.outputDirectory
    )
  }

  async function generateOpenGraphImages(
    route: ConfigRoute,
    browser: Browser,
    serverUrl: URL
  ): Promise<Array<GeneratedOpenGraphImage>> {
    if (!route.path) {
      return []
    }

    const createRoutePath = compile(route.path)
    const resourceUrl = new URL(route.path, serverUrl)
    // Set the "_data" search parameter so the route can be queried
    // like a resource route although it renders UI.
    resourceUrl.searchParams.set('_data', route.id)

    // Fetch all the params data from the route.
    const allData = await fetch(resourceUrl, {
      headers: {
        'user-agent': OPEN_GRAPH_USER_AGENT_HEADER,
      },
    }).then<Array<OpenGraphImageData>>((response) => response.json())
    /**
     * @todo Improve error handling:
     * - OG route forgetting to return the data;
     * - OG route returning invalid data;
     */

    const files: Array<GeneratedOpenGraphImage> = []

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

          files.push({
            name: `${data.name}.${format}`,
            content: optimizedImageBuffer,
          })
        } finally {
          await page.close({ runBeforeUnload: false })
        }
      })
    )

    return files
  }

  async function writeImageToDisk(image: GeneratedOpenGraphImage) {
    const filePath = path.resolve(await getOutputDirectory(), image.name)
    const directoryName = path.dirname(filePath)
    if (!fs.existsSync(directoryName)) {
      await fs.promises.mkdir(directoryName, { recursive: true })
    }
    await fs.promises.writeFile(filePath, image.content)
  }

  return {
    name: PLUGIN_NAME,

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
        /**
         * @note Parse the route module and remove the special export altogether.
         * This way, it won't be present in the client bundle, and won't affect
         * "vite-plugin-react" and its HMR.
         */
        const ast = parse(code, { sourceType: 'module' })
        const refs = findReferencedIdentifiers(ast)

        traverse(ast, {
          Identifier(path) {
            if (
              t.isIdentifier(path.node) &&
              path.node.name === EXPORT_NAME &&
              (t.isFunctionDeclaration(path.parent) ||
                (t.isVariableDeclarator(path.parent) &&
                  t.isArrowFunctionExpression(path.parent.init)))
            ) {
              path.replaceWith(t.identifier('undefined'))
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
        ).then((images) => images.map(writeImageToDisk))
      } else {
        // In build mode, collect all the OG image routes to be
        // visited on build end, when the application build is done.
        routesWithImages.add(route)
      }
    },

    /**
     * @note Use `writeBundle` and not `closeBundle` so the image generation
     * time is counted toward the total build time.
     */
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
                .then((images) => Promise.all(images.map(writeImageToDisk)))
                .catch((error) => {
                  this.error(
                    `Failed to generate OG image for route "${route.id}": ${error}`
                  )
                })
            }
          )

          await Promise.allSettled(pendingScreenshots)
          await Promise.all([server.close(), browser.close()])
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
    /**
     * @note Using `production` mode is important.
     * It will skip all the built-in development-oriented plugins in Vite.
     */
    'production',
    'development',
    false
  )

  const server = await createServer(previewViteConfig.inlineConfig)
  return server.listen()
}
