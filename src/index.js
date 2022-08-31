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

function logWarning(server, err) {
  server.config.logger.warn(buildErrorMessage(err, [colors.yellow(err.message)]), {
    clear: false,
    timestamp: true,
    error: err
  })
}

function logError(server, err) {
  server.config.logger.error(buildErrorMessage(err, [colors.red(err.message)]), {
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
const melangeLogRE2 = /> File "(?<file>.+)", lines? (?<line>[\d-]+), characters (?<col>[\d-]+):\r?\n(?<frame>(> \d+[^]+?(?=\r?\n> \D))+)\r?\n(> (?<arrows>[ \^]+)\r?\n)?(?<message>(> .+\r?\n)+)/g

// function compile(id) {
//   // console.log('COMPILING for ' + id);
//   // TODO: make configurable
//   let { status, stderr, stdout } = spawnSync('esy', ['mel', 'build']);
//   if (status !== 0) {
//     throw parseError(stderr.toString());
//   }
// }
function compile(id) {
  console.log('COMPILING');
  // TODO: make configurable
  // spawn('esy', ['mel', 'build', '--watch']);
  // compiler.stdout.on('data', (data) => {
  //   console.log(`stdout: ${data}`);
  // });
  //
  // compiler.stderr.on('data', (data) => {
  //     console.error(`stderr: ${data}`);
  //   if (data.toString().startsWith('Waiting for filesystem changes...')) {
  //     console.log('good')
  //     // throw parseError(data.toString());
  //   }
  //   else
  //   {
  //     console.log('error')
  //   }
  // });
  //
  // compiler.on('close', (code) => {
  //   console.log(`child process exited with code ${code}`);
  // });
  // if (status !== 0) {
  //   throw parseError(stderr.toString());
  // }
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

function parseLog(log) {
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
  const lineBorderIndex = match.groups.frame.indexOf('|')
  console.log(match.groups.frame)
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

function isMelangeLog(id) {
  return id == join(cwd(), '_build/log');
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

    buildStart(options) {
      console.log('build start')
      console.log(join(cwd(), '_build/log'))
        this.addWatchFile(join(cwd(), '_build/log'));
        compile();
      console.log(this.getWatchFiles())
    },

    async resolveId(source, importer, options) {
        // this.addWatchFile(join(cwd(), '_build/log'));
      source = cleanUrl(source);
      importer = importer && cleanUrl(importer);
      // We use the Melange entrypoint to compile for the first time
      // TODO: make entrypoint configurable
      if (source.endsWith('main.bs.js')) {
        console.log('first compile ' + source)
        // compile(source);
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

    async transform(code, id) {
      if (id.endsWith('main.bs.js')) {
      console.log(this.getWatchFiles())
        // console.log('transform ' + id);
        // this.addWatchFile(join(cwd(), '_build/log'));
        // console.log(join(cwd(), '_build/log'));
      // this.warn(id);
        }
        
      return null;
    },

    async load(id) {
      id = cleanUrl(id);
      if (isMelangeSource(id)) {
        console.log('loading ml file')
        try {
          return await fsp.readFile(sourceToBuiltFile(id), 'utf-8')
        } catch (e) {
          // If a compiled file is imported but missing,
          // we compile again
          if (e.code === 'ENOENT') {
            console.log('compile at load')
            // compile(id);
          } else {
            throw e;
          }
        }
      }
      return null;
    },

    async handleHotUpdate({ file, modules, read, server }) {
      if (isMelangeLog(file)) {
        console.log('log changed ' + file)
        const log = await read()
        console.log(melangeLogRE2)
        const matches = log.matchAll(melangeLogRE2)
        // console.log(matches)
        for (let match of matches) {
          // console.log(match)
          const err = createViteError(match);
          console.log(err)

          if (err.isError) {
            logError(server, err)
          } else {
            logWarning(server, err)
          }
        }
        // console.log(log)
        // if ((match = log.matchAll(melangeLogRE2)) !== null) {

        // }
        // console.log('log: ' + log)
      }
      // We compile when a source file has changed
      if (isMelangeSource(file)) {
        try {
          console.log('compile at hmr')
          // compile(file);
        } catch (err) {
      // console.log('hot error');
          logError(server, err);
        }
      }

      // If compiled files are mistakenly watched by Vite,
      // wrong modules can be added to the graph
      return modules.filter(mod => !mod.url.endsWith('.bs.js.ml'));
    },

    watchChange(id) {
      console.log('change ' + id);
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
