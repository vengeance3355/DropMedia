import type { NextConfig } from 'next'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const config: NextConfig = {
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url))
}

export default config
