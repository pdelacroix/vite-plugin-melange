import colors from 'picocolors'
import strip from 'strip-ansi'
import { join } from 'path';
import { cwd } from 'process';
import { spawnSync } from 'child_process';
import { existsSync, promises as fsp } from 'fs';

// TODO: make configurable
// TODO: use Vite root
const src_dir = join(cwd(), '/src')
const build_dir = join(cwd(), '/_build/default/src')
const deps_dir = join(cwd(), '/_build/default/node_modules')

/*
** Code from Vite
*/

const queryRE = /\?.*$/s
const hashRE = /#.*$/s

const cleanUrl = (url) => url.replace(hashRE, '').replace(queryRE, '')

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
  args = [colors.red(err.message)]
  if (err.plugin) args.push(`  Plugin: ${colors.magenta(err.plugin)}`)
  if (err.id) args.push(`  File: ${colors.cyan(err.id)}`)
  if (err.frame) args.push(colors.yellow(pad(err.frame)))
  if (includeStack && err.stack) args.push(pad(cleanStack(err.stack)))
  return args.join('\n')
}

function cleanStack(stack) {
  return stack
    .split(/\n/g)
    .filter((l) => /^\s*at/.test(l))
    .join('\n')
}

function logError(server, err) {
  server.config.logger.error(buildErrorMessage(err), {
    clear: true,
    timestamp: true,
    error: err
  })

  server.ws.send({
    type: 'error',
    err: prepareError(err)
  })
}

const splitRE = /\r?\n/

function pad(source, n = 2) {
  const lines = source.split(splitRE)
  return lines.map((l) => ` `.repeat(n) + l).join(`\n`)
}

const esyLogRE = /error: (?<message>[^]+?(?=\r?\nesy: exiting due to errors above))/
const melangeLogRE = /File "(?<file>.+)", line (?<line>\d+), characters (?<col>[\d-]+):\r?\n(?<frame>.*)\r?\n(?<arrows>.*)\r?\n(?<message>([^]+?(?=\r?\nFile)|[^]+))/

function compile(id) {
  // console.log('COMPILING for ' + id);
  // TODO: make configurable
  let { status, stderr, stdout } = spawnSync('esy', ['mel', 'build']);
  if (status !== 0) {
    throw parseError(stderr.toString());
  }
}

function parseError(stderr) {
  // console.log(stderr);
  let match;
  if ((match = stderr.match(esyLogRE)) !== null) {
    return {
      plugin: 'melange-plugin',
      pluginCode: "ESY_ERROR",
      message: 'Esy error:\n' + match.groups.message
    }
  }
  else if ((match = stderr.match(melangeLogRE)) !== null) {
    return createViteError(match);
  }
  else {
    return {
      plugin: 'melange-plugin',
      pluginCode: "UNKNOWN_ERROR",
      message: stderr
    }
  }
}

function createViteError(match) {
  const lineBorderIndex = match.groups.frame.indexOf('|') + 2;
  const frame = '> ' + match.groups.frame + '\n' + match.groups.arrows.slice(0, lineBorderIndex) + '| ' + match.groups.arrows.slice(lineBorderIndex);
  let file;
  if (match.groups.file.includes(build_dir)) {
    file = match.groups.file.replace(build_dir, src_dir);
  } else {
    file = join(cwd(), match.groups.file);
  }
  let message = 'Melange compilation failed:\n' + match.groups.message

  return {
    plugin: 'melange-plugin',
    pluginCode: "MELANGE_COMPILATION_FAILED",
    message: message,
    frame: frame,
    stack: '',
    id: file,
    loc: {
      file: file,
      line: match.groups.line,
      column: match.groups.col,
    }
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

    async resolveId(source, importer, options) {
      source = cleanUrl(source);
      importer = importer && cleanUrl(importer);
      // We use the Melange entrypoint to compile for the first time
      // TODO: make entrypoint configurable
      if (source === '/src/main.ml') {
        compile(source);
      }

      // Sometimes Melange outputs dependency compiled files
      // in `_build/default/node_modules/`,
      // instead of beside source files, in `node_modules/`
      if (!source.startsWith('/') && !source.startsWith('.') && existsSync(deps_dir + '/' + source)) {
        return { id: deps_dir + '/' + source, moduleSideEffects: null };
      }

      // When a compiled file imports another compiled file,
      // `importer` will be the source file, so we resolve from the compiled file
      // and then return the source path for the resulting file
      if (source.endsWith('.bs.js') && source.startsWith('.') && isMelangeSource(importer)) {
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
        try {
          return await fsp.readFile(sourceToBuiltFile(id), 'utf-8')
        } catch (e) {
          // If a compiled file is imported but missing,
          // we compile again
          if (e.code === 'ENOENT') {
            compile(id);
          } else {
            throw e;
          }
        }
      }
      return null;
    },

    async handleHotUpdate({ file, modules, server }) {
      // We compile when a source file has changed
      if (isMelangeSource(file)) {
        try {
          compile(file);
        } catch (err) {
          logError(server, err);
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
