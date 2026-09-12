// Free-identifier check for the dashboard's ES modules.
//
// Written because splitting large components by hand kept producing files that BUILD fine
// and then throw ReferenceError in the browser: esbuild does not resolve identifiers, so a
// component that lost an import when its code moved compiles cleanly and dies on render.
// Three such faults slipped through a passing build during the 2026-09-12 split, each found
// only by driving the UI. This finds them in a second.
//
//   npm run lint:undef
//
// src/__tests__ is excluded by that script: those files run under Jest, whose describe/test/
// expect/jest globals this checker has no reason to know about.
//
// It parses each file with acorn (+JSX), collects declared names (imports, params,
// destructuring, function and class names, catch bindings) and reports every identifier
// used but never declared and not a known global.

// Find free (undeclared) identifiers in a module, using esbuild's own parser via a
// scope-less heuristic is unreliable -- so use acorn from vite's dep tree instead.
import jsx from 'acorn-jsx';
import fs from 'fs';
import path from 'path';

const GLOBALS = new Set(['window','document','console','Math','JSON','Object','Array','String','Number','Boolean','Date','Promise','Map','Set','WeakMap','Error','fetch','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','localStorage','sessionStorage','navigator','location','URL','Blob','FormData','AbortController','Intl','isNaN','isFinite','parseFloat','parseInt','encodeURIComponent','decodeURIComponent','undefined','NaN','Infinity','structuredClone','performance','React','globalThis','process','Buffer','TextEncoder','TextDecoder','CustomEvent','Event','EventSource','WebSocket','Image','atob','btoa','crypto','alert','confirm','queueMicrotask','Int16Array','Int8Array','Uint16Array','Uint32Array','Float64Array','ResizeObserver','TextDecoderStream','TextEncoderStream','ReadableStream','WritableStream','AbortSignal','Headers','Request','Response','WeakSet','Audio','Worker','BroadcastChannel','IntersectionObserver','MutationObserver','matchMedia','history','screen','self','top','parent','frames','HTMLElement','Node','Element','SVGElement','Uint8Array','Float32Array','Int32Array','ArrayBuffer','DataView','Symbol','Proxy','Reflect','BigInt','RegExp','Function','TypeError','RangeError','eval','arguments','require','module','exports','__dirname','__filename']);

const { Parser: AcornParser } = await import('acorn');
const P = AcornParser.extend(jsx());

function collect(file) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = P.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch (e) { return { file, error: e.message }; }

  const declared = new Set();
  const used = new Map(); // name -> line

  function declarePattern(node) {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': declared.add(node.name); break;
      case 'ObjectPattern': node.properties.forEach(p => declarePattern(p.value || p.argument)); break;
      case 'ArrayPattern': node.elements.forEach(declarePattern); break;
      case 'AssignmentPattern': declarePattern(node.left); break;
      case 'RestElement': declarePattern(node.argument); break;
      case 'Property': declarePattern(node.value); break;
    }
  }

  function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
        node.specifiers.forEach(s => declared.add(s.local.name)); return;
      case 'VariableDeclarator': declarePattern(node.id); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) declared.add(node.id.name);
        node.params.forEach(declarePattern);
        break;
      case 'ClassDeclaration': if (node.id) declared.add(node.id.name); break;
      case 'CatchClause': declarePattern(node.param); break;
      case 'MethodDefinition': case 'PropertyDefinition':
        if (node.key && node.key.type === 'Identifier') declared.add(node.key.name);
        break;
      case 'MetaProperty': return;   // import.meta
      case 'Identifier': {
        const skip = parent && (
          (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) ||
          (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) ||
          (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent.type === 'Property' && parent.key === node && !parent.computed) ||
          (parent.type === 'JSXAttribute' && parent.name === node) ||
          parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' ||
          parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier'
        );
        if (!skip && !used.has(node.name)) used.set(node.name, node.loc?.start?.line ?? 0);
        break;
      }
      case 'JSXIdentifier': {
        if (parent && parent.type === 'JSXAttribute') break;
        if (parent && parent.type === 'JSXMemberExpression' && parent.property === node) break;
        if (/^[a-z]/.test(node.name)) break; // intrinsic element
        if (!used.has(node.name)) used.set(node.name, node.loc?.start?.line ?? 0);
        break;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, node));
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  }
  walk(ast, null);
  const free = [...used.keys()].filter(n => !declared.has(n) && !GLOBALS.has(n));
  return { file, free };
}

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const r = collect(f);
  if (r.error) { console.log(`PARSE ERROR ${f}: ${r.error}`); bad++; continue; }
  if (r.free.length) { console.log(`UNDEFINED in ${f}: ${r.free.join(', ')}`); bad++; }
}
console.log(bad ? `\n${bad} file(s) with problems` : 'all clean');
