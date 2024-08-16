import fs from 'node:fs'
import path from 'node:path'
import { type Plugin, type ResolvedConfig, normalizePath } from 'vite'
import { parse as esModuleLexer } from 'es-module-lexer'
import type { ResolvedRemixConfig } from '@remix-run/dev'
import type { ConfigRoute } from '@remix-run/dev/dist/config/routes.js'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { compile } from 'path-to-regexp'
import { launch } from 'puppeteer'
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
;``
const EXPORT_NAME = 'openGraphImage'

export function openGraphImagePlugin(options: Options): Plugin {
  const viteConfigPromise = new DeferredPromise<ResolvedConfig>()
  const remixContextPromise = new DeferredPromise<RemixPluginContext>()
  const serverUrlPromise = new DeferredPromise<URL>()
  const routesWithImages = new Array<ConfigRoute>()

  const format = options.format || 'jpeg'

  const browserPromise = launch({ headless: true })

  async function getOutputDirectory() {
    const viteConfig = await viteConfigPromise

    return path.resolve(
      viteConfig.root || process.cwd(),
      options.outputDirectory
    )
  }

  async function generateOpenGraphImages(route: ConfigRoute) {
    if (!route.path) {
      return
    }

    const serverUrl = await serverUrlPromise
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

    const browser = await browserPromise

    for (const data of allData) {
      const page = await browser.newPage()

      try {
        const pageUrl = new URL(createRoutePath(data.params), serverUrl).href
        await page.goto(pageUrl, { waitUntil: 'networkidle0' })

        const ogImageBoundingBox = await page
          .$(options.elementSelector)
          .then((element) => {
            return element?.boundingBox()
          })

        if (!ogImageBoundingBox) {
          return
        }

        await page.setViewport({
          width: ogImageBoundingBox.width,
          height: ogImageBoundingBox.height,
          // Use a larger scale factor to get a crisp image.
          deviceScaleFactor: 2,
        })

        const screenshot = await page.screenshot({
          type: format,
          quality: 100,
          encoding: 'binary',
          clip: ogImageBoundingBox,
        })

        const outputDirectory = await getOutputDirectory()

        if (!fs.existsSync(outputDirectory)) {
          await fs.promises.mkdir(outputDirectory, { recursive: true })
        }

        await fs.promises.writeFile(
          path.resolve(outputDirectory, `${data.name}.jpg`),
          screenshot
        )
      } finally {
        await page.close({ runBeforeUnload: false })
      }
    }
  }

  return {
    name: 'vite-remix-og-image-plugin',
    enforce: 'post',
    config(config) {
      remixContextPromise.resolve(Reflect.get(config, '__remixPluginContext'))
    },
    configResolved(config) {
      viteConfigPromise.resolve(config)
    },
    configureServer(server) {
      const { httpServer } = server

      if (!httpServer) {
        return
      }

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
      if (options.ssr) {
        return
      }

      const remixContext = await remixContextPromise

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

      const exports = esModuleLexer(code)[1]

      // Ignore routes that don't have the root-level special export.
      const ogImageExport = exports.find((e) => e.n === EXPORT_NAME)

      if (!ogImageExport) {
        return
      }

      this.debug(`found og image route: ${route.id}`)

      generateOpenGraphImages(route).then(() => {
        this.info(`generated og image for route: ${route.id}`)
      })

      routesWithImages.push(route)
    },
    async buildEnd() {
      // Generate the images on build end, when all the assets are ready.
      // await Promise.all(routesWithImages.map(generateOpenGraphImages))
      await browserPromise.then((browser) => browser.close())
    },
  }
}