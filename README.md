# vite-plugin-melange

A Vite plugin for Melange.

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

## Build

```bash
npm install
npm run build
```
