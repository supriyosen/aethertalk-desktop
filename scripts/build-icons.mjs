import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const sourceIcon = path.join(projectRoot, 'public', 'app-icon.svg')
const buildDir = path.join(projectRoot, 'build')
const iconPng = path.join(buildDir, 'icon.png')
const iconsetDir = path.join(buildDir, 'icon.iconset')
const iconIcns = path.join(buildDir, 'icon.icns')

await mkdir(buildDir, { recursive: true })

execFileSync('sips', ['-s', 'format', 'png', sourceIcon, '--out', iconPng], {
  stdio: 'ignore',
})

if (process.platform === 'darwin' && existsSync(iconPng)) {
  await rm(iconsetDir, { force: true, recursive: true })
  await mkdir(iconsetDir, { recursive: true })

  const sizes = [
    16,
    32,
    64,
    128,
    256,
    512,
  ]

  for (const size of sizes) {
    execFileSync('sips', ['-z', String(size), String(size), iconPng, '--out', path.join(iconsetDir, `icon_${size}x${size}.png`)], {
      stdio: 'ignore',
    })
  }

  execFileSync('sips', ['-z', '32', '32', iconPng, '--out', path.join(iconsetDir, 'icon_16x16@2x.png')], {
    stdio: 'ignore',
  })
  execFileSync('sips', ['-z', '64', '64', iconPng, '--out', path.join(iconsetDir, 'icon_32x32@2x.png')], {
    stdio: 'ignore',
  })
  execFileSync('sips', ['-z', '256', '256', iconPng, '--out', path.join(iconsetDir, 'icon_128x128@2x.png')], {
    stdio: 'ignore',
  })
  execFileSync('sips', ['-z', '512', '512', iconPng, '--out', path.join(iconsetDir, 'icon_256x256@2x.png')], {
    stdio: 'ignore',
  })
  execFileSync('sips', ['-z', '1024', '1024', iconPng, '--out', path.join(iconsetDir, 'icon_512x512@2x.png')], {
    stdio: 'ignore',
  })

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', iconIcns], {
    stdio: 'ignore',
  })
}

console.log(`Desktop icon assets are ready in ${buildDir}`)
