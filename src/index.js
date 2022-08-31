import colors from 'picocolors'
import strip from 'strip-ansi'
import { join } from 'path';
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

const queryRE = /\?.*$/s
const hashRE = /#.*$/s

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
  return id.endsWith('.ml') || id.endsWith('.re');
}

function isMelangeSource(id) {
  return id.startsWith(src_dir) && isMelangeSourceType(id)
}

function sourceToBuiltFile(id) {
  return id.replace(src_dir, build_dir).slice(0, -3) + '.bs.js';
}

function builtFileToSource(id, extension) {
  return id.replace(build_dir, src_dir).slice(0, -6) + extension;
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
        const matches = log.matchAll(melangeLogRE2)
        for (let match of matches) {
          const err = createViteError(match);
          if (err.isError) {
            this.error(err)
            // throw err
          } else {
            this.warn(buildErrorMessage(err, [colors.yellow(err.message)]))
          }
        }
      }
    },
    async load(id) {
      if (id.endsWith('.bs.js')) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
        return null
    },

    async resolveId(source, importer, options) {
      source = cleanUrl(source);
      importer = importer && cleanUrl(importer);

      // Sometimes Melange outputs dependency compiled files
      // in `_build/default/node_modules/`,
      // instead of beside source files, in `node_modules/`
      if (!source.startsWith('/') && !source.startsWith('.') && existsSync(deps_dir + '/' + source)) {
        return { id: deps_dir + '/' + source, moduleSideEffects: null };
      }

      // When a compiled file imports another compiled file,
      // `importer` will be the source file, so we resolve from the compiled file
      // and then return the source path for the resulting file
      // console.log('resolve' + importer + ' ' + source);
      if (source.endsWith('.bs.js') && source.startsWith('.') && isMelangeSource(importer)) {
        // console.log('resolved');
        const importerExtension = importer.slice(-3);
        importer = sourceToBuiltFile(importer);
        const resolution = await this.resolve(source, importer, { skipSelf: true, ...options });
        if (resolution && resolution.id.startsWith(build_dir)) {
          return { id: builtFileToSource(resolution.id, importerExtension) }
        }
      }
      return null;
    },

    async load(id) {
      id = cleanUrl(id);
      if (isMelangeSource(id)) {
        // console.log('loading ml file')
        return await fsp.readFile(sourceToBuiltFile(id), 'utf-8')
      }
      return null;
    },

    async handleHotUpdate({ file, modules, read, server }) {
      // @TODO fix case
      if (file.endsWith('.bs.js')) {
        console.log(file)
        // console.log(modules)
      }
      if (file == melange_log_file) {
        const log = await read()
        const matches = log.matchAll(melangeLogRE2)
        for (let match of matches) {
          const err = createViteError(match);
          if (err.isError) {
            logError(server, err)
            server.ws.send({
              type: 'error',
              err: prepareError(err)
            })
          } else {
            logWarning(server, err)
          }
        }
      }

      // If compiled files are mistakenly watched by Vite,
      // wrong modules can be added to the graph
      return modules.filter(mod => !mod.url.endsWith('.bs.js.ml'));
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (isMelangeSourceType(cleanUrl(req.url))) {
          res.setHeader('Content-Type', 'application/javascript');
        }
        next();
      })
    }
  }
}
