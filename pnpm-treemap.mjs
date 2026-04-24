#!/usr/bin/env node
/**
 * pnpm-treemap.mjs
 *
 * Reads pnpm-lock.yaml from a repo and outputs a self-contained HTML treemap.
 * Each workspace is a group; each direct dep is a cell sized by how many
 * transitive deps it pulls in. Big cells = big dep trees.
 *
 * Usage:
 *   node pnpm-treemap.mjs <repo-path> [output.html]
 *
 * Arguments:
 *   repo-path:  path to the repo root containing pnpm-lock.yaml (required)
 *   output:     output HTML file path (default: pnpm-treemap.html)
 *
 * Install dependencies first:
 *   npm install   (or pnpm install / yarn)
 */

import { readWantedLockfile } from '@pnpm/lockfile-file'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const repoPath    = process.argv[2]
if (!repoPath) {
  console.error('Usage: node pnpm-treemap.mjs <repo-path> [output.html]')
  process.exit(1)
}

const lockfileDir = resolve(repoPath)
const outputPath  = resolve(process.argv[3] ?? 'pnpm-treemap.html')

console.error(`Reading lockfile from: ${lockfileDir}`)
const lockfile = await readWantedLockfile(lockfileDir, { ignoreIncompatible: false })

if (!lockfile) {
  console.error('No lockfile found.')
  process.exit(1)
}

const packages  = lockfile.packages  ?? {}
const snapshots = lockfile.snapshots ?? {} // v9 internal format puts dep info here
const importers = lockfile.importers ?? {}

// --- Build adjacency map: pkgId -> Set of direct dep pkgIds ---

function pkgKey(name, version) {
  // version may already contain peer suffix like "1.2.3(peer@1.0.0)"
  return `${name}@${version}`
}

function stripLeadingSlash(key) {
  return key.startsWith('/') ? key.slice(1) : key
}

const adj = new Map() // pkgId -> string[]

for (const [rawKey, pkg] of Object.entries(Object.keys(snapshots).length ? snapshots : packages)) {
  const id   = stripLeadingSlash(rawKey)
  const deps = []

  for (const [name, version] of Object.entries(pkg.dependencies         ?? {})) deps.push(pkgKey(name, version))
  for (const [name, version] of Object.entries(pkg.optionalDependencies ?? {})) deps.push(pkgKey(name, version))

  adj.set(id, deps)
}

// --- Memoized transitive dep count via iterative DFS ---

const memo = new Map() // pkgId -> Set<pkgId> (all transitive deps)

function transitiveSet(rootId) {
  if (memo.has(rootId)) return memo.get(rootId)

  const visited = new Set()
  const stack   = [rootId]

  while (stack.length) {
    const id = stack.pop()
    if (visited.has(id)) continue
    visited.add(id)
    for (const dep of (adj.get(id) ?? [])) {
      if (!visited.has(dep)) stack.push(dep)
    }
  }

  visited.delete(rootId) // don't count the root itself
  memo.set(rootId, visited)
  return visited
}

// --- Build treemap hierarchy ---

const root = { name: 'pnpm', children: [] }

for (const [importerPath, importer] of Object.entries(importers)) {
  const workspaceName = importerPath === '.' ? '(root)' : importerPath.replace(/^packages\//, '')
  const workspaceNode = { name: workspaceName, children: [] }

  const allDeps = {
    ...importer.dependencies,
    ...importer.devDependencies,
    ...importer.optionalDependencies,
  }

  for (const [depName, depSpec] of Object.entries(allDeps)) {
    // lockfile v6: depSpec is { specifier, version }; v9: depSpec is a plain version string
    const version = typeof depSpec === 'string' ? depSpec : depSpec.version
    const id    = pkgKey(depName, version)
    const tDeps = transitiveSet(id)
    workspaceNode.children.push({
      name:          depName,
      version,
      transitiveCount: tDeps.size,
      value:         tDeps.size + 1, // +1 so zero-dep packages still have area
    })
  }

  // Compute exclusive transitive count: deps reachable from this dep but not from any sibling
  const allSets = workspaceNode.children.map(c => transitiveSet(pkgKey(c.name, c.version)))
  for (let i = 0; i < workspaceNode.children.length; i++) {
    const othersUnion = new Set()
    for (let j = 0; j < allSets.length; j++) {
      if (j !== i) for (const id of allSets[j]) othersUnion.add(id)
    }
    const exclusive = [...allSets[i]].filter(id => !othersUnion.has(id)).length
    workspaceNode.children[i].exclusiveCount = exclusive
    workspaceNode.children[i].exclusiveValue = exclusive + 1
  }

  // Sort largest first so the treemap layout is deterministic
  workspaceNode.children.sort((a, b) => b.value - a.value)

  if (workspaceNode.children.length > 0) {
    root.children.push(workspaceNode)
  }
}

// Sort workspaces by total transitive dep count
root.children.sort((a, b) => {
  const sumA = a.children.reduce((s, c) => s + c.value, 0)
  const sumB = b.children.reduce((s, c) => s + c.value, 0)
  return sumB - sumA
})

const dataJson = JSON.stringify(root)

console.error(`Workspaces: ${root.children.length}`)
console.error(`Total direct deps across all workspaces: ${root.children.reduce((s, w) => s + w.children.length, 0)}`)

// --- Emit self-contained HTML ---

const html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>pnpm dependency treemap</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; height: 100vh; display: flex; flex-direction: column; }
    #header { padding: 10px 16px; background: #1a1a2e; display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
    #header h1 { font-size: 14px; font-weight: 600; }
    #mode-toggle { display: flex; gap: 4px; }
    #mode-toggle button { padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #444; background: #2a2a3e; color: #ccc; cursor: pointer; }
    #mode-toggle button.active { background: #7eb8f7; color: #111; border-color: #7eb8f7; font-weight: 600; }
    #breadcrumb { font-size: 13px; color: #aaa; }
    #breadcrumb span { cursor: pointer; color: #7eb8f7; }
    #breadcrumb span:hover { text-decoration: underline; }
    #tooltip {
      position: fixed; pointer-events: none; background: rgba(0,0,0,.85);
      border: 1px solid #444; border-radius: 6px; padding: 8px 12px;
      font-size: 12px; line-height: 1.6; z-index: 10; display: none;
      max-width: 320px;
    }
    #chart { flex: 1; overflow: hidden; }
    svg { width: 100%; height: 100%; }
    .node rect { stroke: #111; stroke-width: 1px; rx: 2; cursor: pointer; transition: opacity .15s; }
    .node rect:hover { opacity: .8; }
    .node text { pointer-events: none; fill: #fff; font-size: 11px; dominant-baseline: hanging; }
    .workspace-label { font-size: 12px; font-weight: 700; fill: #fff; pointer-events: none; dominant-baseline: hanging; }
  </style>
</head>
<body>
  <div id="header">
    <h1>pnpm dependency treemap</h1>
    <div id="breadcrumb"><span id="bc-root">root</span></div>
    <div id="mode-toggle">
      <button id="btn-total" class="active" onclick="setMode('total')">total transitive</button>
      <button id="btn-exclusive" onclick="setMode('exclusive')">exclusive transitive</button>
    </div>
  </div>
  <div id="tooltip"></div>
  <div id="chart"></div>

  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    const DATA = ${dataJson};

    const color = d3.scaleOrdinal(d3.schemeTableau10)

    const tooltip = document.getElementById('tooltip')

    let currentRoot      = DATA
    let currentWorkspace = null
    let currentMode      = 'total' // 'total' | 'exclusive'

    function setMode(mode) {
      currentMode = mode
      document.getElementById('btn-total').classList.toggle('active', mode === 'total')
      document.getElementById('btn-exclusive').classList.toggle('active', mode === 'exclusive')
      render(currentRoot, currentWorkspace)
    }

    function render(node, workspaceName) {
      currentRoot      = node
      currentWorkspace = workspaceName ?? null

      // Breadcrumb
      const bc = document.getElementById('breadcrumb')
      if (workspaceName) {
        bc.innerHTML = \`<span id="bc-root">root</span> / \${workspaceName}\`
        document.getElementById('bc-root').addEventListener('click', () => render(DATA, null))
      } else {
        bc.innerHTML = \`<span id="bc-root">root</span>\`
      }

      const container = document.getElementById('chart')
      container.innerHTML = ''
      const W = container.clientWidth
      const H = container.clientHeight

      const svg = d3.select(container).append('svg')
        .attr('viewBox', \`0 0 \${W} \${H}\`)

      const valueKey = currentMode === 'exclusive' ? 'exclusiveValue' : 'value'
      const countKey = currentMode === 'exclusive' ? 'exclusiveCount' : 'transitiveCount'

      const hierarchy = d3.hierarchy(node).sum(d => d[valueKey] ?? d.value ?? 0)

      d3.treemap()
        .size([W, H])
        .paddingTop(workspaceName ? 4 : 22)
        .paddingInner(2)
        .paddingOuter(workspaceName ? 1 : 4)
        (hierarchy)

      const isLeafView = !!workspaceName

      const nodes = svg.selectAll('g')
        .data(hierarchy.descendants().filter(d => isLeafView ? d.depth === 1 : d.depth <= 1))
        .join('g')
          .attr('class', 'node')
          .attr('transform', d => \`translate(\${d.x0},\${d.y0})\`)

      nodes.append('rect')
        .attr('width',  d => Math.max(0, d.x1 - d.x0))
        .attr('height', d => Math.max(0, d.y1 - d.y0))
        .attr('fill', d => {
          if (isLeafView) return d3.interpolateRdYlGn(1 - Math.min((d.data[countKey] ?? 0) / 300, 1))
          return color(d.data.name)
        })
        .attr('fill-opacity', d => isLeafView || d.depth === 1 ? 0.85 : 0.4)
        .on('mousemove', (event, d) => {
          let lines
          if (isLeafView) {
            lines = [
              \`<b>\${d.data.name}</b>\`,
              \`version: \${d.data.version}\`,
              \`total transitive: \${d.data.transitiveCount}\`,
              \`exclusive transitive: \${d.data.exclusiveCount}\`,
            ]
          } else {
            lines = [
              \`<b>\${d.data.name}</b>\`,
              \`direct deps: \${(d.data.children ?? []).length}\`,
              \`total transitive (est): \${d3.sum(d.data.children ?? [], c => c.transitiveCount)}\`,
              \`exclusive transitive: \${d3.sum(d.data.children ?? [], c => c.exclusiveCount)}\`,
            ]
          }
          tooltip.innerHTML = lines.join('<br/>')
          tooltip.style.display = 'block'
          tooltip.style.left = (event.clientX + 14) + 'px'
          tooltip.style.top  = (event.clientY + 14) + 'px'
        })
        .on('mouseleave', () => tooltip.style.display = 'none')
        .on('click', (event, d) => {
          if (!isLeafView && d.depth === 1) render(d.data, d.data.name)
        })

      nodes.append('text')
        .attr('class', d => (!isLeafView && d.depth === 1) ? 'workspace-label' : null)
        .attr('x', 4).attr('y', 4)
        .text(d => {
          const w     = d.x1 - d.x0
          const count = d.data[countKey] ?? ''
          const label = isLeafView ? \`\${d.data.name} (\${count})\` : d.data.name
          return w < 40 ? '' : label.length * 6.5 > w ? label.slice(0, Math.floor(w / 6.5) - 1) + '…' : label
        })
    }

    render(DATA, null)
    window.addEventListener('resize', () => render(currentRoot, currentWorkspace))
  </script>
</body>
</html>
`

writeFileSync(outputPath, html, 'utf8')
console.error(`Written to: ${outputPath}`)
console.error(`Open in a browser: open ${outputPath}`)
