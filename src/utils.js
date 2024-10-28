import getEtag from "etag";
import colors from "picocolors";
import strip from "strip-ansi";

/*
 ** Code from Vite
 */

const ERR_OPTIMIZE_DEPS_PROCESSING_ERROR = "ERR_OPTIMIZE_DEPS_PROCESSING_ERROR";
const ERR_OUTDATED_OPTIMIZED_DEP = "ERR_OUTDATED_OPTIMIZED_DEP";
const NULL_BYTE_PLACEHOLDER = `__x00__`;
const VALID_ID_PREFIX = `/@id/`;

const importQueryRE = /(\?|&)import=?(?:&|$)/;
const trailingSeparatorRE = /[\?&]$/;
const timestampRE = /\bt=\d{13}&?\b/;

function removeTimestampQuery(url) {
  return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
}

function removeImportQuery(url) {
  return url.replace(importQueryRE, "$1").replace(trailingSeparatorRE, "");
}

// Strip valid id prefix. This is prepended to resolved Ids that are
// not valid browser import specifiers by the importAnalysis plugin.
function unwrapId(id) {
  return id.startsWith(VALID_ID_PREFIX) ? id.slice(VALID_ID_PREFIX.length) : id;
}

const isDebug = !!process.env.DEBUG;

function genSourceMapUrl(map) {
  if (typeof map !== "string") {
    map = JSON.stringify(map);
  }
  return `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
}

function getCodeWithSourcemap(type, code, map) {
  if (isDebug) {
    code += `\n/*${JSON.stringify(map, null, 2).replace(/\*\//g, "*\\/")}*/\n`;
  }

  if (type === "js") {
    code += `\n//# sourceMappingURL=${genSourceMapUrl(map ?? undefined)}`;
  } else if (type === "css") {
    code += `\n/*# sourceMappingURL=${genSourceMapUrl(map ?? undefined)} */`;
  }

  return code;
}

const alias = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
};

function send(req, res, content, type, options) {
  const {
    etag = getEtag(content, { weak: true }),
    cacheControl = "no-cache",
    headers,
    map,
  } = options;

  if (res.writableEnded) {
    return;
  }

  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader("Content-Type", alias[type] || type);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Etag", etag);

  if (headers) {
    for (const name in headers) {
      res.setHeader(name, headers[name]);
    }
  }

  // inject source map reference
  if (map && map.mappings) {
    if (type === "js" || type === "css") {
      content = getCodeWithSourcemap(type, content.toString(), map);
    }
  }

  res.statusCode = 200;
  res.end(content);
  return;
}

const postfixRE = /[?#].*$/;

export function cleanUrl(url) {
  return url.replace(postfixRE, '');
}

export function splitFileAndPostfix(path)  {
  const file = cleanUrl(path);
  return { file, postfix: path.slice(file.length) };
}

// used to propagate errors for WS in dev server mode
export function prepareError(err) {
  // only copy the information we need and avoid serializing unnecessary
  // properties, since some errors may attach full objects (e.g. PostCSS)
  return {
    message: strip(err.message),
    stack: strip(cleanStack(err.stack || "")),
    id: err.id,
    frame: strip(err.frame || ""),
    plugin: err.plugin,
    pluginCode: err.pluginCode,
    loc: err.loc,
  };
}

function pad(source, n = 2) {
  const lines = source.split(splitRE);
  return lines.map((l) => ` `.repeat(n) + l).join(`\n`);
}

export function buildErrorMessage(err, args, includeStack = true) {
  if (err.plugin) args.push(`  Plugin: ${colors.magenta(err.plugin)}`);
  const loc = err.loc ? `:${err.loc.line}:${err.loc.column}` : "";
  if (err.id) args.push(`  File: ${colors.cyan(err.id)}${loc}`);
  if (err.frame) args.push(colors.yellow(pad(err.frame)));
  if (includeStack && err.stack) args.push(pad(cleanStack(err.stack)));
  return args.join("\n");
}

function cleanStack(stack) {
  return stack
    .split(/\n/g)
    .filter((l) => /^\s*at/.test(l))
    .join("\n");
}

function posToNumber(source, pos) {
  if (typeof pos === "number") return pos;
  const lines = source.split(splitRE);
  const { line, column } = pos;
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    start += lines[i].length + 1;
  }
  return start + column;
}

const splitRE = /\r?\n/g;

const range = 2;

export function generateCodeFrame(source, start = 0, end) {
  start = Math.max(posToNumber(source, start), 0);
  end = Math.min(
    end !== undefined ? posToNumber(source, end) : start,
    source.length
  );
  const lines = source.split(splitRE);
  let count = 0;
  const res = [];
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length;
    if (count >= start) {
      for (let j = i - range; j <= i + range || end > count; j++) {
        if (j < 0 || j >= lines.length) continue;
        const line = j + 1;
        res.push(
          `${line}${" ".repeat(Math.max(3 - String(line).length, 0))}|  ${
            lines[j]
          }`
        );
        const lineLength = lines[j].length;
        if (j === i) {
          // push underline
          const pad = Math.max(start - (count - lineLength), 0);
          const length = Math.max(
            1,
            end > count ? lineLength - pad : end - start
          );
          res.push(`   |  ` + " ".repeat(pad) + "^".repeat(length));
        } else if (j > i) {
          if (end > count) {
            const length = Math.max(Math.min(end - count, lineLength), 1);
            res.push(`   |  ` + "^".repeat(length));
          }
          count += lineLength + 1;
        }
      }
      break;
    }
    count++;
  }
  return res.join("\n");
}

export async function transformMiddleware(server, req, res, next) {
  // this is what the transform middleware does for filetypes it
  // recognizes (js, tx...), this is mostly a copy
  try {
    let url = decodeURI(removeTimestampQuery(req.url)).replace(
      NULL_BYTE_PLACEHOLDER,
      "\0"
    );
    url = removeImportQuery(url);
    // Strip valid id prefix. This is prepended to resolved Ids that are
    // not valid browser import specifiers by the importAnalysis plugin.
    url = unwrapId(url);

    // check if we can return 304 early
    const ifNoneMatch = req.headers["if-none-match"];
    if (
      ifNoneMatch &&
      (await server.moduleGraph.getModuleByUrl(url, false))?.transformResult
        ?.etag === ifNoneMatch
    ) {
      // isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
      res.statusCode = 304;
      return res.end();
    }

    // resolve, load and transform using the plugin container
    const result = await server.transformRequest(url, server, {
      html: req.headers.accept?.includes("text/html"),
    });
    if (result) {
      return send(req, res, result.code, "js", {
        etag: result.etag,
        // allow browser to cache npm deps!
        cacheControl: "no-cache",
        headers: server.config.server.headers,
        map: result.map,
      });
    }
  } catch (e) {
    if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
      // Skip if response has already been sent
      if (!res.writableEnded) {
        res.statusCode = 504; // status code request timeout
        res.end();
      }
      // This timeout is unexpected
      logger.error(e.message);
      return;
    }
    if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
      // Skip if response has already been sent
      if (!res.writableEnded) {
        res.statusCode = 504; // status code request timeout
        res.end();
      }
      // We don't need to log an error in this case, the request
      // is outdated because new dependencies were discovered and
      // the new pre-bundle dependencies have changed.
      // A full-page reload has been issued, and these old requests
      // can't be properly fulfilled. This isn't an unexpected
      // error but a normal part of the missing deps discovery flow
      return;
    }
    return next(e);
  }
}
