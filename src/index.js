import colors from 'picocolors'
import strip from 'strip-ansi'
import { join, extname } from 'path';
import { cwd } from 'process';
import { spawnSync } from 'child_process';
import { existsSync, promises as fsp } from 'fs';

// TODO: make configurable
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

const logRegex = /File "(?<file>.+)", line (?<line>\d+), characters (?<col>[\d-]+):\n(?<frame>.*)\n(?<arrows>.*)\n(?<message1>.+)(\n(?<message2>.+))?(\n(?<message3>.+))?/g

function compile(id) {
  // console.log('COMPILING for ' + id);
  // TODO: make configurable
  let { status, stderr, stdout } = spawnSync('esy', ['bsb', '-make-world']);
  if (status === 0) {
    return [];
  }
  // TODO: throw an exception
  return [...stderr.toString().matchAll(logRegex)];
}

function createViteError(err) {
  const lineBorderIndex = err[0].groups.frame.indexOf('|') + 2;
  const frame = '> ' + err[0].groups.frame + '\n' + err[0].groups.arrows.slice(0, lineBorderIndex) + '| ' + err[0].groups.arrows.slice(lineBorderIndex);
  const file = err[0].groups.file.replace(build_dir, src_dir)
  let message = 'Melange compilation failed:';
  if (err[0].groups.message1)
    message += '\n' + err[0].groups.message1
  if (err[0].groups.message2)
    message += '\n' + err[0].groups.message2
  if (err[0].groups.message3)
    message += '\n' + err[0].groups.message3

  return {
    plugin: 'melange-plugin',
    pluginCode: "MELANGE_COMPILATION_FAILED",
    message: message,
    frame: frame,
    stack: '',
    id: file,
    loc: {
      file: file,
      line: err[0].groups.line,
      column: err[0].groups.col,
    }
  };
}

function isMelangeSourceType(id) {
  return id.endsWith('.ml') || id.endsWith('.re');
}

function isMelangeSource(id) {
  return id.startsWith(src_dir) && isMelangeSource(id)
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
      // We use the Melange entrypoint to compile for the first time
      // TODO: make entrypoint configurable
      if (source === '/src/main.ml') {
        const err = compile();
        if (err.length > 0) {
          const viteErr = createViteError(err);
          this.error(viteErr);
        }
      }

      // Sometimes Melange outputs dependency compiled files
      // in `_build/default/node_modules/`,
      // instead of besides source files, in `node_modules/`
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
      if (isMelangeSource(id)) {
        try {
          return await fsp.readFile(sourceToBuiltFile(id), 'utf-8')
        } catch (e) {
          // If a compiled file is imported but missing,
          // we compile again
          if (e.code === 'ENOENT') {
            const err = compile(id);
            if (err.length > 0) {
              const viteErr = createViteError(err);
              this.error(viteErr);
            }
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
        const err = compile(file);
        if (err.length > 0) {
          const viteErr = createViteError(err);
          logError(server, viteErr);

          return [];
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
