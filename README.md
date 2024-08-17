# `remix-og-image`

Build-time in-browser Open Graph image generation plugin for Remix.

## Motivation

When I came to generating OG images for my Remix app, I realized that it's an unsolved problem. A general recommendation is to use something like [Satori](https://github.com/vercel/satori), which renders a React component to an SVG, and then use extra tools to convert the SVG into an image.

That approach is nice, but it has some significant drawbacks. First, it's a _runtime_ generation. It literally happens when your user's browser hits `./og-image.jpeg`. It's another serverless function invocation, another compute, more latency, and all that comes with that. Second, such an approach is limited by design. You want a template for your image, and React is a great choice for that. But the only reliable way to render a React component is in the actual browser. Otherwise, you have to bring in additional resources and setup to make things work, like loading fonts, assets, etc.

I really wanted a simple _built-time_ image generation. In fact, I've been using a custom script to generate images for my blog using Playwright for years. And it worked, it just was a bit disjoined from the rest of my build.

Then it occured to me: why not take my script and turn it into a Vite plugin? You are looking at that plugin right now.

## Features

The biggest feature of this plugin is the in-browser rendering. To put it extremely briefly: you create a route for OG images, write your React component template, and the plugin knows which routes to visit during the build, takes their screenshots using Puppeteer, and emits them on disk.

Here's a longer version of that:

- 🚀 **No limitations**. I mean it. Use the same styles, fonts, assets, components, utilities, and anything else you already use.
- 💎 **Pixel-perfect rendering**. This plugin takes a screenshot of your special OG image route in the actual browser, giving you 1-1 browser rendering without compromise.
- 👁️ **Retina-ready**. All images are generated with x2 device scale factor, then compressed and optimized to deliver the best quality/file size ratio.
- 🛠️ **Build-time**. You want build-time OG image generation most of the time. This plugin does just that. Get the images on the disk, pay no runtime cost whatsoever. Both static and dynamic routes are supported!
- 💅 **Interactive**. OG image is just a React component rendered in a route in your app. Visit that route to iterate your image and bring it to perfection. No extra steps to preview/debug it. It's literally a React component without magic.

## Usage

### Step 1: Install

```sh
npm i remix-og-image
```

### Step 2: Add plugin

```js
// vite.config.js
import { openGraphImagePlugin } from 'remix-og-image/plugin'

export default defineConfig({
  plugins: [
    // ...the rest of your plugins.
    openGraphImagePlugin({
      // Specify a selector for the DOM element on the page
      // that the plugin should screenshot.
      elementSelector: '#og-image',

      // Specify where to save the generated images.
      outputDirectory: './public/og',
    }),
  ],
})
```

### Step 3: Create OG route

This library needs a designated Remix route responsible for rendering OG images. Don't fret, it's your regular Remix route with _one_ tiny exception:

```jsx
// app/routes/og.jsx
import { json } from '@remix-run/react'
import { isOpenGraphImageRequest } from 'remix-og-image'

// 👉 1. Export the special `openGraphImage` function.
// This function returns an array of OG image generation entries.
// In the example below, it generates only one image called "og-image.jpeg"
export function openGraphImage() {
  return [
    // The `name` property controls the generated
    // image's file name.
    { name: 'og-image' }
  ]
}

// 2a. Add the `loader` export.
export function loader({ request }}) {
  // 👉 2b. First, check if the incoming request is a meta request
  // from the plugin. Use the `isOpenGraphImageRequest` utility from the library.
  if (isOpenGraphImageRequest(request)) {
    /**
     * @note Throw the OG image response instead of returning it.
     * This way, you don't have to deal with the `loader` function
     * returning a union of OG image data and the actual data
     * returned to the UI component.
     */
    throw json(openGraphImage())
  }

  // Compute and return any data needed for the OG image.
  // In this case, this is a static route.
  return null
}

// 👉 3. Create a React component for your OG image.
// Use whichever other components, styles, utilities, etc.
// your app already has. No limits!
export default function Template() {
  return (
    <div id="og-image">
      <h1>My site</h1>
    </div>
  )
}
```

<!-- prettier-ignore -->
> [!IMPORTANT]
> **The `openGraphImage` export is special**. Everything else is your regular Remix route.

You can then reference the generated OG images in the `meta` export of your page:

```jsx
// app/routes/page.jsx
export function meta() {
  return [
    {
      name: 'og:image',
      content: '/og/og-image.jpeg',
      //            👆👆👆👆👆
      // This is the value of the `name` property
      // you provided in the `openGraphImage` export
      // of your OG image route.
    },
  ]
}
```

## Recipes

### Dynamic data

One of the selling points of generating OG images is including _dynamic data_ in them.

This plugin supports generating multiple OG images from a single route by returning an array of data alternations from the `openGraphImage` function:

```jsx
// app/routes/post.$slug.og.jsx
export function openGraphImage() {
  // Return a dynamic number of OG image entries
  // based on your data. The plugin will automatically
  // provide the "params" to this route when
  // visiting each alternation of this page in the browser.
  return allPosts.map((post) => {
    return {
      name: post.slug,
      params: { slug: post.slug },
    }
  })
}

export async function loader({ request, params }) {
  if (isOpenGraphImageRequest(request)) {
    throw json(openGraphImage())
  }

  const { slug } = params
  const book = await getBookBySlug(slug)

  return { book }
}

export default function Template() {
  const { book } = useLoaderData()

  return (
    <div
      id="og-image"
      className="w-[1200px] h-[630px] bg-blue-100 flex items-center justify-center"
    >
      <h1 className="text-4xl">{book.title}</h1>
    </div>
  )
}
```

Use the same dynamic data you provided as `name` in the `openGraphImage` function to access the generated OG images in your route:

```jsx
// app/routes/post.$slug.jsx

export function meta({ params }) {
  const { slug } = params

  // ...validate the params.

  return [
    {
      name: 'og:image',
      content: `/og/${slug}.jpeg`,
      //            👆👆👆👆
    },
  ]
}
```

## Frequently Asked Questions

### How does this plugin work?

1. The plugin spawns a single Chromium instance.
1. The plugin finds any routes with the `openGraphImage()` export.
1. The plugin requests the route as a data route (a special request) to get whatever you returned from the `openGraphImage()` function. In response, the plugin receives the list of OG images (and their data) to generate.
1. The plugin iterates over each OG image entry, visiting the route in the browser, providing it whatever `params` you provided in the `openGraphImage()` function. This way, it support dynamic OG images!
1. Finally, the plugin takes a screenshot of the OG image element on the page, and writes it as an image to disk. 🎉

### How to set the image size?

This plugin treats your OG image React component as the source of truth. The dimensions of your OG image will be the same as the dimensions of the DOM element representing it.

```jsx
export default function Template() {
  return (
    <div id="og-image" style={{ width: 1200, height: 630 }}>
      Hello world!
    </div>
  )
}
```

> For example, this `Template` component renders the `#og-image` element as a `1200x630` block. That will be the size of the generated OG image.
