import colors from 'picocolors'
import strip from 'strip-ansi'
import { join, extname } from 'path';
import { cwd } from 'process';
import { spawnSync, spawn } from 'child_process';
import { readFileSync, existsSync, promises as fsp } from 'fs';
// TODO: make configurable
// TODO: use Vite root
const src_dir = join(cwd(), '/src')
const build_dir = join(cwd(), '/_build/default/src')
const deps_dir = join(cwd(), '/_build/default/node_modules')
const melange_log_file = join(cwd(), '_build/log')

/*
** Code from Vite
*/

const ERR_OPTIMIZE_DEPS_PROCESSING_ERROR =
  'ERR_OPTIMIZE_DEPS_PROCESSING_ERROR'
const ERR_OUTDATED_OPTIMIZED_DEP = 'ERR_OUTDATED_OPTIMIZED_DEP'

const queryRE = /\?.*$/s
const hashRE = /#.*$/s
const importQueryRE = /(\?|&)import=?(?:&|$)/
const trailingSeparatorRE = /[\?&]$/
const NULL_BYTE_PLACEHOLDER = `__x00__`
const VALID_ID_PREFIX = `/@id/`
const timestampRE = /\bt=\d{13}&?\b/

function removeTimestampQuery(url) {
  return url.replace(timestampRE, '').replace(trailingSeparatorRE, '')
}

function removeImportQuery(url) {
  return url.replace(importQueryRE, '$1').replace(trailingSeparatorRE, '')
}

// Strip valid id prefix. This is prepended to resolved Ids that are
// not valid browser import specifiers by the importAnalysis plugin.
function unwrapId(id) {
  return id.startsWith(VALID_ID_PREFIX) ? id.slice(VALID_ID_PREFIX.length) : id
}


import getEtag from 'etag'

const isDebug = !!process.env.DEBUG

export function genSourceMapUrl(map) {
  if (typeof map !== 'string') {
    map = JSON.stringify(map)
  }
  return `data:application/json;base64,${Buffer.from(map).toString('base64')}`
}

export function getCodeWithSourcemap(
  type,
  code,
  map
) {
  if (isDebug) {
    code += `\n/*${JSON.stringify(map, null, 2).replace(/\*\//g, '*\\/')}*/\n`
  }

  if (type === 'js') {
    code += `\n//# sourceMappingURL=${genSourceMapUrl(map ?? undefined)}`
  } else if (type === 'css') {
    code += `\n/*# sourceMappingURL=${genSourceMapUrl(map ?? undefined)} */`
  }

  return code
}

const alias = {
  js: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json'
}

function send(
  req,
  res,
  content,
  type,
  options
) {
  const {
    etag = getEtag(content, { weak: true }),
    cacheControl = 'no-cache',
    headers,
    map
  } = options

  if (res.writableEnded) {
    return
  }

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  res.setHeader('Content-Type', alias[type] || type)
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Etag', etag)

  if (headers) {
    for (const name in headers) {
      res.setHeader(name, headers[name])
    }
  }

  // inject source map reference
  if (map && map.mappings) {
    if (type === 'js' || type === 'css') {
      content = getCodeWithSourcemap(type, content.toString(), map)
    }
  }

  res.statusCode = 200
  res.end(content)
  return
}

const cleanUrl = (url) => url.replace(hashRE, '').replace(queryRE, '')

// used to propagate errors for WS in dev server mode
function prepareError(err) {
  // only copy the information we need and avoid serializing unnecessary
  // properties, since some errors may attach full objects (e.g. PostCSS)
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || '')),
    id: err.id,
    frame: strip(err.frame || ''),
    plugin: err.plugin,
    pluginCode: err.pluginCode,
    loc: err.loc
  }
}

function buildErrorMessage(
  err,
  args,
  includeStack = true
) {
  // if (err.plugin) args.push(`  Plugin: ${colors.magenta(err.plugin)}`)
  // @TODO we can add line and column numbers
  if (err.id) args.push(`${colors.white('file:')} ${colors.cyan(err.id)}`)
  if (err.frame) args.push(colors.yellow(err.frame))
  if (includeStack && err.stack) args.push(cleanStack(err.stack))
  return args.join('\n') + '\n'
}

function cleanStack(stack) {
  return stack
    .split(/\n/g)
    .filter((l) => /^\s*at/.test(l))
    .join('\n')
}

function logWarning(server, err) {
  server.config.logger.warn(buildErrorMessage(err, [colors.yellow(err.message)]), {
    clear: false,
    timestamp: true,
    error: err
  })
}

function logError(server, err) {
  server.config.logger.error(buildErrorMessage(err, [colors.red(err.message)]), {
    clear: false,
    timestamp: true,
    error: err
  })
}

const esyLogRE = /error: (?<message>[^]+?(?=\r?\nesy: exiting due to errors above))/
const melangeLogRE = /File "(?<file>.+)", line (?<line>\d+), characters (?<col>[\d-]+):\r?\n(?<frame>.*)\r?\n(?<arrows>.*)\r?\n(?<message>([^]+?(?=\r?\nFile)|[^]+))/
const melangeLogRE2 = /> File "(?<file>.+)", lines? (?<line>[\d-]+), characters (?<col>[\d-]+):\r?\n(?<frame>(> \d+[^]+?(?=\r?\n> \D))+)\r?\n(> (?<arrows>[ \^]+)\r?\n)?(?<message>(> .+\r?\n)+)/g

// function compile(id) {
//   // console.log('COMPILING for ' + id);
//   // TODO: make configurable
//   let { status, stderr, stdout } = spawnSync('esy', ['mel', 'build']);
//   if (status !== 0) {
//     throw parseError(stderr.toString());
//   }
// }
function launchMel() {
  // TODO: make configurable
  spawnSync('esy', ['mel', 'build']);
}

function launchMelWatch() {
  // TODO: make configurable
  spawn('esy', ['mel', 'build', '--watch']);
}

function createViteError(match) {
  const lineBorderIndex = match.groups.frame.indexOf('|')
  let frame = match.groups.frame
  if (match.groups.arrows) {
    frame += '\n' + match.groups.arrows.slice(0, lineBorderIndex) + '| ' + match.groups.arrows.slice(lineBorderIndex);
  }
  let file;
  if (match.groups.file.includes(build_dir)) {
    file = match.groups.file.replace(build_dir, src_dir);
  } else {
    file = join(cwd(), match.groups.file);
  }

  return {
    plugin: 'melange-plugin',
    pluginCode: "MELANGE_COMPILATION_FAILED",
    message: match.groups.message.replace(/^> /gm, '').replace(/^Error: /, ''),
    frame: frame,
    stack: '',
    id: file,
    loc: {
      file: file,
      line: match.groups.line.replace(/-\d+/, ''),
      column: match.groups.col,
    },
    isError: /^> Error: /.test(match.groups.message)
  };
}

function isMelangeSourceType(id) {
  return id.endsWith('.ml') || id.endsWith('.re') || id.endsWith('.res');
}

function isMelangeSource(id) {
  return id.startsWith(src_dir) && isMelangeSourceType(id)
}

function sourceToBuiltFile(id) {
  return id.replace(src_dir, build_dir).replace(/\.(ml|re|res)$/, '') + '.bs.js';
}

function builtFileToSource(id, extension) {
  if (extension) {
    return id.replace(build_dir, src_dir).replace(/\.bs\.js$/, '') + extension;
  } else {
    return id.replace(build_dir, src_dir)
  }
}

function parseLog(log, onError, onWarn) {
  const matches = log.matchAll(melangeLogRE2)
  for (let match of matches) {
    const err = createViteError(match);
    if (err.isError) {
      onError(err)
      // throw err
    } else {
      onWarn(err)
    }
  }
}


export default function melangePlugin() {
  return {
    name: 'melange-plugin',
    enforce: 'pre',

    buildStart() {
      if (this.meta.watchMode) {
        launchMelWatch()
        // this does not work at the moment so we rely on handleHotUpdate
        // this.addWatchFile(melange_log_file);
      } else {
        launchMel()
        const log = readFileSync(melange_log_file, 'utf-8')
        parseLog(log, (err) => {
          this.error(err)
          // throw err
        }, (err) => {
          this.warn(buildErrorMessage(err, [colors.yellow(err.message)]))
        })
      }
    },

    async resolveId(source, importer, options) {
      console.log(importer + ' -> ' + source)
      // console.log('resolve' + importer + ' ' + source);
      source = cleanUrl(source);
      importer = importer && cleanUrl(importer);

      // Sometimes Melange outputs dependency compiled files
      // in `_build/default/node_modules/`,
      // instead of beside source files, in `node_modules/`
      console.log(deps_dir + '/' + source)
      if (!source.startsWith('/') && !source.startsWith('.') && existsSync(deps_dir + '/' + source)) {
        return { id: deps_dir + '/' + source, moduleSideEffects: null };
      }

      // When a compiled file imports another compiled file,
      // `importer` will be the source file, so we resolve from the compiled file
      // and then return the source path for the resulting file
      if (source.endsWith('.bs.js')) {
        console.log('in1');
        let setExtension
        let resolution
        let sourceFile
        if (importer.endsWith('index.html') && isMelangeSource(source)) {
          console.log('in2');
          setExtension = null
          source = source.replace(/\.bs\.js$/, '')
        } else if (isMelangeSource(importer) && source.startsWith('.')) {
          console.log('in3');
          setExtension = extname(importer)
          importer = sourceToBuiltFile(importer);
        } else {
          console.log('in4');
          return null
        }
        resolution = await this.resolve(source, importer, { skipSelf: true, ...options });
        sourceFile = builtFileToSource(resolution.id, setExtension)
        if (resolution && resolution.id.startsWith(build_dir) && existsSync(sourceFile)) {
          console.log(resolution.id)
          console.log(sourceFile)
          return { id: sourceFile }
        }
      }

      return null
    },

    async load(id) {
      id = cleanUrl(id);
      console.log(id)
      if (isMelangeSource(id)) {
        console.log('loading ml file')
        return await fsp.readFile(sourceToBuiltFile(id), 'utf-8')
      }
      return null;
    },

    async handleHotUpdate({ file, modules, read, server }) {
      // @TODO fix case
      if (file == melange_log_file) {
        const log = await read()
        parseLog(log, (err) => {
          logError(server, err)
          server.ws.send({
            type: 'error',
            err: prepareError(err)
          })
        }, (err) => {
          logWarning(server, err)
        })
      }

      return modules
    },

    configureServer(server) {
      console.log('conf')
      server.middlewares.use(async function(req, res, next) {
        console.log(req.url)
        if (isMelangeSourceType(cleanUrl(req.url))) {

          try {
            let url = decodeURI(removeTimestampQuery(req.url)).replace(NULL_BYTE_PLACEHOLDER, '\0')
            // console.log('ml')
            // res.setHeader('Content-Type', 'application/javascript');
            url = removeImportQuery(url)
            // Strip valid id prefix. This is prepended to resolved Ids that are
            // not valid browser import specifiers by the importAnalysis plugin.
            url = unwrapId(url)

            // check if we can return 304 early
            const ifNoneMatch = req.headers['if-none-match']
            if (
              ifNoneMatch &&
              (await moduleGraph.getModuleByUrl(url, false))?.transformResult
                ?.etag === ifNoneMatch
            ) {
              isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
              res.statusCode = 304
              return res.end()
            }

            // resolve, load and transform using the plugin container
            const result = await server.transformRequest(url, server, {
              html: req.headers.accept?.includes('text/html')
            })
            if (result) {
              return send(req, res, result.code, 'js', {
                etag: result.etag,
                // allow browser to cache npm deps!
                cacheControl: 'no-cache',
                headers: server.config.server.headers,
                map: result.map
              })
            }
          } catch (e) {
            if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
              // Skip if response has already been sent
              if (!res.writableEnded) {
                res.statusCode = 504 // status code request timeout
                res.end()
              }
              // This timeout is unexpected
              logger.error(e.message)
              return
            }
            if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
              // Skip if response has already been sent
              if (!res.writableEnded) {
                res.statusCode = 504 // status code request timeout
                res.end()
              }
              // We don't need to log an error in this case, the request
              // is outdated because new dependencies were discovered and
              // the new pre-bundle dependencies have changed.
              // A full-page reload has been issued, and these old requests
              // can't be properly fulfilled. This isn't an unexpected
              // error but a normal part of the missing deps discovery flow
              return
            }
            return next(e)
          }
        }

        next()
      })
    }
  }
}
