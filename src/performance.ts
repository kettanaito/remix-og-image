import {
  performance as nativePerformance,
  PerformanceObserver,
} from 'node:perf_hooks'

const { LOG_PERFORMANCE } = process.env

if (LOG_PERFORMANCE) {
  const observer = new PerformanceObserver((items) => {
    items.getEntries().forEach((entry) => {
      console.log(entry)
    })
  })

  observer.observe({ entryTypes: ['measure'], buffered: true })
}

export const performance = LOG_PERFORMANCE
  ? nativePerformance
  : {
      mark() {},
      measure() {},
    }
