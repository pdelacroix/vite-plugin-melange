# vite-plugin-melange

A Vite plugin for Melange.

## Features

- Compile Melange source files as part of the build
- Show errors on the commandline and in the browser overlay
- HMR (hot module replacement) with Melange source filenames as module names

## Usage

```bash
npm install --save-dev vite-plugin-melange
```

`vite.config.js`:
```javascript
import { defineConfig } from "vite";
import melangePlugin from "vite-plugin-melange";

export default defineConfig({
  plugins: [
    melangePlugin({
      buildCommand: "opam exec -- dune build",
      watchCommand: "opam exec -- dune build --watch",
    }),
  ]
});
```

## Options

- `buildCommand`: *(required)* Dune build command. For instance: `opam exec -- dune build`
- `watchCommand`: *(required)* Dune watch command. For instance: `opam exec -- dune build --watch`
- `buildContext`: *(default: `"default"`)* Dune [build context](https://dune.readthedocs.io/en/stable/overview.html#term-build-context). The default corresponds to Dune's default
- `emitDir`: *(default: `"."`)* Directory (relative to Vite root) where the `melange.emit` stanza is located. It defaults to the current directory, which is [the recommended location](https://melange.re/v1.0.0/build-system/#guidelines-for-melangeemit)
- `buildTarget`: *(default: `"output"`)* `target` field of the `melange.emit` stanza. It defines [the directory where the JavaScript artifacts will be placed](https://dune.readthedocs.io/en/stable/melange.html#melange-emit)
- `duneDir`: *(default: `"."`)* Directory (relative to Vite root) where Dune is running (can be used for instance if `dune-project` is in the parent directory). You may also need to add it to [`server.fs.allow`](https://vitejs.dev/config/server-options.html#server-fs-allow).

## Build

```bash
npm install
npm run build
```
