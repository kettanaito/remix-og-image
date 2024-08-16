import fs from 'node:fs'
import path from 'node:path'
import { type Plugin, type ResolvedConfig, normalizePath } from 'vite'
import { parse as esModuleLexer } from 'es-module-lexer'
import type { ResolvedRemixConfig } from '@remix-run/dev'
import type { ConfigRoute } from '@remix-run/dev/dist/config/routes.js'
import { DeferredPromise } from '@open-draft/deferred-promise'
import { compile } from 'path-to-regexp'
import { launch } from 'puppeteer'

interface Options {
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

const EXPORT_NAME = 'openGraphImage'

export interface OgImageData {
  name: string
  params: Record<string, string>
}

export function isOpenGraphImageRequest(request: Request): boolean {
  return request.headers.get('user-agent') === 'vite-remix-og-image-plugin'
}

export function openGraphImagePlugin(options: Options): Plugin {
  const viteConfigPromise = new DeferredPromise<ResolvedConfig>()
  const remixContextPromise = new DeferredPromise<RemixPluginContext>()
  const serverUrlPromise = new DeferredPromise<URL>()

  const format = options.format || 'jpeg'

  // Launch the browser straight away.
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
        agent: 'vite-plugin-og-image',
      },
    }).then<Array<OgImageData>>((response) => response.json())

    for (const data of allData) {
      const browser = await browserPromise
      const page = await browser.newPage()
      const pageUrl = new URL(createRoutePath(data.params), serverUrl).href
      await page.goto(pageUrl, { waitUntil: 'networkidle0' })
      await page.setViewport({
        width: 1200,
        height: 630,
      })

      const ogImageBoundingBox = await page.$('#og-image').then((element) => {
        return element?.boundingBox()
      })

      if (!ogImageBoundingBox) {
        return
      }

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

      generateOpenGraphImages(route)
    },
    async buildEnd() {
      /**
       * @todo Generate all OG images on build end?
       */

      await browserPromise.then((browser) => browser.close())
    },
  }
}
