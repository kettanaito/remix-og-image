# `vite-remix-og-image-plugin`

Build-time in-browser Open Graph image generation plugin for Remix (well, technically, Vite).

## Motivation

When I came to generating OG images for my Remix app, I realized that it's an unsolved problem. A general recommendation is to use something like [Satori](https://github.com/vercel/satori), which renders a React component to an SVG, and then use extra tools to convert the SVG into an image.

That approach is nice, but it has some significant drawbacks. First, it's a _runtime_ generation. It literally happens when your user's browser hits `./og-image.jpeg`. It's another serverless function invocation, another compute, more latency, and all that comes with that. Second, such an approach is limited by design. You want a template for your image, and React is a great choice for that. But the only reliable way to render a React component is in the actual browser. Otherwise, you have to bring in additional resources and setup to make things work, like loading fonts, assets, etc.

I really wanted a simple _built-time_ image generation. In fact, I've been using a custom script to generate images for my blog using Playwright for years. And it worked, it just was a bit disjoined from the rest of my build.

Then it occured to me: why not take my script and turn it into a Vite plugin? You are looking at that plugin right now.

## Features

The biggest feature of this plugin is the in-browser rendering. To put it extremely briefly: you create a route for OG images, write your React component template, and the plugin knows which routes to visit during the build, takes their screenshots using Puppeteer, and emits them on disk.

Here's a longer version of that:

- **No limitations**. I mean it. Use the same styles, fonts, assets, components, utilities, and anything else you already use.
- **Pixel-perfect rendering**. This plugin takes a screenshot of your special OG image route in the actual browser, giving you 1-1 browser rendering without compromise.
- **Build-time**. You want build-time OG image generation most of the time. This plugin does just that. Get the images on the disk, pay no runtime cost whatsoever. Both static and dynamic images are supported!
- **Interactive**. OG image is just a React component rendered in a route in your app. Visit that route to iterate your image and bring it to perfection. No extra steps to preview/debug it. It's literally a React component without magic.

## Usage

### Step 1: Install

```sh
npm i vite-remix-og-image-plugin
```

### Step 2: Add plugin

```js
// vite.config.js
import { openGraphImagePlugin } from 'vite-remix-og-image-plugin'

export default defineConfig({
  plugins: [
    // ...the rest of your plugins.
    openGraphImagePlugin(),
  ],
})
```

### Step 3: Create OG route

This library needs a special Remix route responsible for rendering OG images. Don't fret, it's your regular Remix route with _one_ tiny exception:

```jsx
// app/routes/og.jsx
import { isOpenGraphImageRequest } from 'vite-remix-og-image-plugin'

// 1. Export the special `openGraphImages` function.
// This function returns an array of OG image generation entries.
// In the example below, it generates only one image called "og-image.jpeg"
export function openGraphImages() {
  return [
    { name: 'og-image' }
  ]
}

// 2a. Add the `loader` export.
export function loader({ request }}) {
  // 2b. First, check if the incoming request is a meta request
  // from the plugin. Use the `isOpenGraphImageRequest` utility from the library.
  if (isOpenGraphImageRequest(request)) {
    return openGraphImages()
  }

  // Compute and return any data needed for the OG image.
  // In this case, this is a static route.
  return null
}

// 3. Create a React component for your OG image.
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
> **The `openGraphImages` export is special**. Everything else is your regular Remix route.

## How does this work?

1. The plugin spawns a single Chromium instance.
1. The plugin finds any routes with the `openGraphImages()` export.
1. The plugin requests the route as a data route (a special request) to get whatever you returned from the `openGraphImages()` function. In response, the plugin receives the list of OG images (and their data) to generate.
1. The plugin iterates over each OG image entry, visiting the route in the browser, providing it whatever `params` you provided in the `openGraphImages()` function. This way, it support dynamic OG images!
1. Finally, the plugin takes a screenshot of the OG image element on the page, and writes it as an image to disk. 🎉

## Recipes

### Dynamic data

One of the selling points of generating OG images is including _dynamic data_ in them.

This plugin supports generating multiple OG images from a single route by returning an array of data alternations from the `openGraphImages` function:

```jsx
// app/routes/post.$slug.jsx
export function openGraphImages() {
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
    return openGraphImages()
  }

  const { slug } = params
  const book = await getBookBySlug(slug)

  return { book }
}

export default function Template() {
  const { book } = useLoaderData()

  return (
    <div className="w-[1200px] h-[630px] bg-blue-100 flex items-center justify-center">
      <h1 className="text-4xl">{book.title}</h1>
    </div>
  )
}
```