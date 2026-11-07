import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = path.dirname(fileURLToPath(import.meta.url))

export default {
  plugins: {
    tailwindcss: { config: path.join(webDir, 'tailwind.config.js') },
    autoprefixer: {},
  },
}
