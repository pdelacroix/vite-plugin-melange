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
  ],
  server: {
    watch: {
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 20,
      },
    },
  },
});
```

The `watch` part is [configuring chokidar](https://github.com/paulmillr/chokidar#performance) so that the many writes Melange does to its log file appear as a single change (we use the log file to determine when compilation has finished). You may have to tweak it, depending on your project and hardware.

## Options

- `buildCommand`: *(required)* Dune build command. For instance: `opam exec -- dune build`
- `watchCommand`: *(required)* Dune watch command. For instance: `opam exec -- dune build --watch`
- `buildContext`: (default: `"default"`) Dune [build context](https://dune.readthedocs.io/en/stable/overview.html#term-build-context). The default corresponds to Dune's default
- `emitDir`: (default: `""`) directory where the `melange.emit` stanza is located. It defaults to empty string, which means the project's root folder, as it's [the recommended location](https://melange.re/v1.0.0/build-system/#guidelines-for-melangeemit)
- `buildTarget`: (default: `"output"`) `target` field of the `melange.emit` stanza. It defines [the directory where the JavaScript artifacts will be placed](https://dune.readthedocs.io/en/stable/melange.html#melange-emit)

## Build

```bash
npm install
npm run build
```
