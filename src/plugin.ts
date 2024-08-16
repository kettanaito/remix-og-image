import fs from 'node:fs'
import path from 'node:path'
import { type Plugin, type ResolvedConfig, normalizePath } from 'vite'
import { parse as esModuleLexer } from 'es-module-lexer'
import type { ResolvedRemixConfig } from '@remix-run/dev'
import type { ConfigRoute } from '@remix-run/dev/dist/config/routes.js'
import { DeferredPromise } from '@open-draft/deferred-promise'
import {
  deadCodeElimination,
  findReferencedIdentifiers,
} from 'babel-dead-code-elimination'
import { compile } from 'path-to-regexp'
import { launch } from 'puppeteer'
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
          .then((element) => {
            return element?.boundingBox()
          })

        if (!ogImageBoundingBox) {
          return
        }

        await page.evaluate((selector) => {
          const element = document.querySelector(selector)
          if (element) {
            element.scrollIntoView(true)
          }
        }, options.elementSelector)

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

      this.debug(`found og image route: ${route.id}`)

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
