import path from "path";
import { spawnSync, spawn } from "child_process";
import { readFileSync, existsSync, promises as fsp } from "fs";
import colors from "picocolors";
import * as rpc from "./rpc";
import * as utils from "./utils";

function build(buildCommand) {
  let args = buildCommand.split(" ");
  let cmd = args.shift();

  return spawnSync(cmd, args);
}

function buildWatch(watchCommand) {
  let args = watchCommand.split(" ");
  let cmd = args.shift();

  return spawn(cmd, args);
}

function createViteErrorFromRpc(error, root) {
  return {
    plugin: "melange-plugin",
    pluginCode: "MELANGE_COMPILATION_FAILED",
    // message: match.groups.message.replace(/^> /gm, "").replace(/^Error: /, ""),
    message: error.message,
    frame:
      error.start &&
      utils.generateCodeFrame(
        readFileSync(error.file, "utf-8"),
        error.start,
        error.end
      ),
    stack: "",
    id: path.relative(root, error.file),
    loc: error.start && {
      file: error.file,
      line: error.start.line,
      column: error.start.column + 1,
    },
    isError: error.severity === "error",
  };
}

function isMelangeSourceType(id) {
  return id.endsWith(".ml") || id.endsWith(".re") || id.endsWith(".res");
}

function tryFiles(files) {
  for (let file of files) {
    if (existsSync(file)) {
      return file;
    }
  }

  return undefined;
}

export default function melangePlugin(options) {
  const {
    buildCommand,
    watchCommand,
    duneDir,
    buildContext,
    buildTarget,
    emitDir,
  } = options;

  let config;
  let duneProcess;
  let currentServer;
  let currentError;

  const changedSourceFiles = new Set();

  const dunePath = () => {
    return path.join(config.root, duneDir || ".");
  };

  const rpcPath = () => {
    return path.join(dunePath(), "_build/.rpc/dune");
  };

  const emitPath = () => {
    return path.join(config.root, emitDir || ".");
  };

  const builtPath = (relativeJsPath) => {
    // https://melange.re/v1.0.0/build-system/#javascript-artifacts-layout
    return path.join(
      dunePath(),
      "_build",
      buildContext || "default",
      path.relative(dunePath(), emitPath()),
      buildTarget || "output",
      relativeJsPath || ""
    );
  };

  const artifactPath = (relativeJsPath) => {
    return path.join(
      dunePath(),
      "_build",
      buildContext || "default",
      relativeJsPath || ""
    );
  };

  const depsDir = () => {
    return builtPath("node_modules");
  };

  const sourceToBuiltFile = (id) => {
    let base;

    if (id.includes(artifactPath(""))) {
      base = artifactPath("");
    } else {
      base = dunePath();
    }
    // console.log(`${base} ${id} ${path.relative(base, id)}`)

    const relativeJsPath = path
      .relative(base, id)
      .replace(/\.(ml|re|res)$/, ".js");

    return builtPath(relativeJsPath);
  };

  const builtFileToSource = (id) => {
    const relativePathAsJs = path.relative(builtPath(), id);

    return tryFiles([
      path.join(config.root, relativePathAsJs.replace(/\.js$/, ".ml")),
      path.join(config.root, relativePathAsJs.replace(/\.js$/, ".re")),
      path.join(config.root, relativePathAsJs.replace(/\.js$/, ".res")),
      path.join(artifactPath(relativePathAsJs).replace(/\.js$/, ".ml")),
      path.join(artifactPath(relativePathAsJs).replace(/\.js$/, ".re")),
      path.join(artifactPath(relativePathAsJs).replace(/\.js$/, ".res")),
    ]);
  };

  const artifactToSource = (id) => {
    if (id.includes(builtPath())) {
      return id.replace(builtPath(), config.root);
    } else {
      return path.join(config.root, id);
    }
  };

  const sendError = function (error) {
    const builtError = utils.buildErrorMessage(error, [
      colors.red(`Internal server error: ${error.message}`),
    ]);

    currentServer.config.logger &&
      currentServer.config.logger.error(builtError, {
        clear: true,
        timestamp: true,
      });

    currentServer.ws &&
      currentServer.ws.send({
        type: "error",
        err: utils.prepareError(error),
      });
  };

  const onSuccess = function () {
    // console.log('Success');

    // this._container.config.logger.clearScreen("error");
    // this._container.config.logger.info(
    //   colors.green("Melange compilation successful")
    // );

    const changedModules = [...changedSourceFiles]
      .map((file) => [
        ...((currentServer.moduleGraph.getModulesByFile(file) &&
          currentServer.moduleGraph.getModulesByFile(file)) ||
          []),
      ])
      .flat();

    changedModules.forEach((module) => {
      module.file = path.relative(config.root, module.file);

      currentServer.reloadModule(module);
    });

    if (changedModules.length === 0 && currentError) {
      if (currentServer.ws.clients.size === 0) {
        this._container.config.logger.clearScreen("error");
        this._container.config.logger.info(
          colors.green("Melange compilation error fixed!")
        );
      } else {
        currentServer.ws.send({ type: "full-reload" });
      }
    }

    changedSourceFiles.clear();

    currentError = null;
  };

  const onDiagnosticAdd = function (error) {
    // console.log('DiagnosticAdd');
    // console.log(error);

    const viteError = createViteErrorFromRpc(error, config.root);

    sendError(viteError);

    currentError = viteError;
  };

  const onDiagnosticRemove = function (error) {
    // console.log('DiagnosticRemove');
    // console.log(error);
  };

  const onRpcError = function (error) {
    console.log("RPC error");
    console.log(error);
  };

  return {
    name: "melange-plugin",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    buildStart() {
      if (this.meta.watchMode) {
        duneProcess = buildWatch(watchCommand);

        let error = "";

        duneProcess.stderr.on("data", (data) => {
          // console.log(data.toString());
          error += data.toString();
        });

        duneProcess.on("close", (code) => {
          if (code === 1 && error != "") {
            console.log(`child process exited with code ${code}`);
            this.error(error);
          }
        });

        process.on("exit", () => {
          duneProcess.kill();
        });

        rpc.init(
          rpcPath(),
          onSuccess.bind(this),
          onDiagnosticAdd.bind(this),
          onDiagnosticRemove.bind(this),
          onRpcError.bind(this)
        );
      } else {
        let child = build(buildCommand);

        if (child.status != 0 && child.stderr) {
          this.error(child.stderr.toString());
        }
      }
    },

    closeBundle() {
      // console.log("close bundle");

      rpc.destroy();
      duneProcess && duneProcess.kill();
    },

    async resolveId(source, importer, options) {
      const {source: file, postfix} = utils.splitFileAndPostfix(source);
      importer = importer && utils.cleanUrl(importer);
      // console.log(`${source} from ${importer}`);

      // Opam deps can get compiled in
      // `_build/$buildContext/$emitDir/$buildTarget/node_modules/`
      // It's the case for `melange` (stdlib), `melange.belt`,
      // `melange.runtime`, `reason-react`...
      if (
        !source.startsWith("/") &&
        !source.startsWith(".") &&
        existsSync(depsDir() + "/" + source)
      ) {
        return { id: depsDir() + "/" + source, moduleSideEffects: null };
      }

      // Normal resolution sometimes does not happen...
      if (isMelangeSourceType(source)) {
        // console.log('importing melange file');

        if (existsSync(source)) {
          return { id: source + postfix };
        }

        const resolution = path.resolve(path.dirname(importer), source);
        if (existsSync(resolution)) {
          // console.log('resolution found');
          return { id: resolution + postfix };
        }
      }

      if (
        !(importer && isMelangeSourceType(importer) && source.startsWith("."))
      ) {
        // console.log('resolveId returning null');
        return null;
      }

      // When a compiled file imports another compiled file,
      // `importer` will be the source file, so we resolve from the compiled file
      // and then return the source path for the resulting file
      importer = sourceToBuiltFile(importer);
      const resolution = path.resolve(path.dirname(importer), source);
      // console.log(`${importer} resolves ${resolution}`);

      if (existsSync(resolution)) {
        // console.log(`${importer} resolves ${resolution} it exists`);
        const sourceFile = builtFileToSource(resolution);
        // console.log(`${source} is ${sourceFile}`);

        if (sourceFile) {
          return { id: sourceFile + postfix };
        } else {
          // if the file imported is `runtime_deps` (from dune), there won't be any sourceFile
          return { id: resolution + postfix };
        }
      }

      return null;
    },

    transformIndexHtml(html) {
      if (currentError) {
        // by throwing in transformIndexHtml, we use the errorMiddleware
        // as soon as possible
        throw currentError;
      } else {
        return html;
      }
    },

    async load(id) {
      id = utils.cleanUrl(id);
      // console.log(`loading ${id}`);

      if (isMelangeSourceType(id)) {
        // console.log(`so loading ${sourceToBuiltFile(id)}`);
        try {
          return await fsp.readFile(sourceToBuiltFile(id), "utf-8");
        } catch (error) {
          return "";
        }
      }

      return null;
    },

    async handleHotUpdate({ file, modules, read, server }) {
      // We don't want to send an HMR update for files that have been updated
      // but make the compilation fail. So we store which files have changed,
      // and when a compilation has succeeded, we send an HMR update for those
      // files and reset the list of changed files.

      if (isMelangeSourceType(file)) {
        changedSourceFiles.add(file);

        return [];
      }

      return modules;
    },

    configureServer(server) {
      currentServer = server;

      server.middlewares.use(async function (req, res, next) {
        if (isMelangeSourceType(utils.cleanUrl(req.url))) {
          return utils.transformMiddleware(server, req, res, next);
        }
        next();
      });
    },
  };
}
