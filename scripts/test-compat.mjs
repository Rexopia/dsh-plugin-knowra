import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(project, 'package.json'))
const version = process.argv[2]
if (!/^0\.2\.(?:0-rc\.2|1-rc\.3)$/.test(version ?? '')) {
  throw new Error('Usage: npm run test:compat -- <0.2.0-rc.2|0.2.1-rc.3>')
}

function run(args, cwd) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Command exited with ${code}: ${args[0]}`)))
  })
}

// Keep DSH packages in a separate tree: npm must not satisfy an rc.2 test
// with this project's rc.3 development peers. A cached full runtime is optional.
const cached = process.env.KNOWRA_COMPAT_RUNTIME_DIR
const runtime = cached ? resolve(cached) : await mkdtemp(join(tmpdir(), 'knowra-dsh-compat-'))
let workspace
try {
  if (!cached) {
    if (!process.env.npm_execpath) throw new Error('Run this script through npm run test:compat')
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await run([process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`], runtime)
  }
  workspace = await mkdtemp(join(runtime, 'knowra-plugin-'))
  for (const entry of ['src', 'tests', 'scripts', 'tsconfig.json', 'package.json']) {
    await cp(join(project, entry), join(workspace, entry), { recursive: true })
  }
  const modules = join(workspace, 'node_modules')
  await mkdir(modules)
  // Reuse the plugin's own SDK, schemas and test tools. All host packages,
  // including Cordis, resolve from the selected runtime's parent node_modules.
  for (const entry of await readdir(join(project, 'node_modules'), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '@deepseek-ai') continue
    await symlink(join(project, 'node_modules', entry.name), join(modules, entry.name), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const hostRequire = createRequire(join(workspace, 'package.json'))
  for (const name of ['dsh', 'dsh-credentials', 'dsh-credentials-local', 'dsh-mcp-client', 'dsh-typert-protocol', 'dsh-typert-loader', 'dsh-typert-registry', 'dsh-api-gateway', 'dsh-tools']) {
    const actual = JSON.parse(await readFile(hostRequire.resolve(`@deepseek-ai/${name}/package.json`), 'utf8')).version
    assert.equal(actual, version, `${name} resolved outside the selected runtime`)
  }
  console.log(`Testing plugin against DSH ${version} on ${process.platform}`)
  const manifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
  const { evaluatePluginCompatibility } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')))
  assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, 'DSH rejected plugin installation')
  // rc.2 discovers host contracts through this package.json export.
  assert.equal(await realpath(hostRequire.resolve('dsh-plugin-knowra/package.json')), await realpath(join(workspace, 'package.json')))
  await run(['scripts/build.mjs'], workspace)
  const { TYPERT } = await import(pathToFileURL(join(workspace, 'lib/typert.host.js')))
  assert.equal(TYPERT.invocations.length, 3, 'Built host contract did not load')
  await run([require.resolve('typescript/bin/tsc'), '--noEmit'], workspace)
  const tests = (await readdir(join(workspace, 'tests'))).filter(name => name.endsWith('.test.ts')).map(name => join(workspace, 'tests', name))
  await run(['--import', pathToFileURL(require.resolve('tsx')).href, '--test', ...tests], workspace)
} finally {
  if (cached) {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  } else {
    await rm(runtime, { recursive: true, force: true })
  }
}
