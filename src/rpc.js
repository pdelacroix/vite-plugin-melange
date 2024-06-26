import * as net from "node:net";
import * as util from "node:util";

var socket;

const initializePayload =
  "((2:id(10:initialize))(6:method10:initialize)(6:params((12:dune_version(1:32:15))(2:id(19:vite-plugin-melange1:3))(16:protocol_version1:0))))";

// this is the whole version payload sent by ocamllsp:
// "((2:id(12:version menu))(6:method12:version_menu)(6:params((7:promote(1:1))(17:poll/running-jobs(1:1))(13:poll/progress(1:11:2))(15:poll/diagnostic(1:11:2))(4:ping(1:1))(16:format-dune-file(1:1))(11:diagnostics(1:11:2))(9:build_dir(1:1))(8:shutdown(1:1))(24:cancel-poll/running-jobs(1:1))(20:cancel-poll/progress(1:1))(22:cancel-poll/diagnostic(1:1))(12:notify/abort(1:1))(10:notify/log(1:1)))))";
const versionsPayload =
  "((2:id(12:version menu))(6:method12:version_menu)(6:params((13:poll/progress(1:11:2))(15:poll/diagnostic(1:11:2)))))";

const pollProgressPayload =
  "((2:id((4:poll(4:auto1:0))(1:i1:0)))(6:method13:poll/progress)(6:params(4:auto1:0)))";

const pollDiagnosticsPayload =
  "((2:id((4:poll(4:auto1:1))(1:i1:0)))(6:method15:poll/diagnostic)(6:params(4:auto1:1)))";

//   { directory: '/home/pierre/dev/melange-vite-template', id: '3', loc: { start: { pos_bol: '0', pos_cnum: '11', pos_fname: '/home/pierre/dev/melange-vite-template/src/truc.re', pos_lnum: '1' }, stop: { pos_bol: '0', pos_cnum: '14', pos_fname: '/home/pierre/dev/melange-vite-template/src/truc.re', pos_lnum: '1' } }, message: [ 'Vbox', [ '0', [ 'Box', [ '0', [ 'Verbatim', 'Unbound value asd\nHint: Did you mean asr?' ] ] ] ] ], promotion: {}, related: {}, severity: 'error', targets: {} }
function make_error(input) {
  return {
    id: parseInt(input.id),
    file: input.loc && input.loc.start.pos_fname,
    start: input.loc && {
      line: parseInt(input.loc.start.pos_lnum),
      column: parseInt(input.loc.start.pos_cnum),
    },
    end: input.loc && {
      line: parseInt(input.loc.stop.pos_lnum),
      column: parseInt(input.loc.stop.pos_cnum),
    },
    message: input.message[1][1][1][1][1],
    severity: input.severity,
  };
}

export function init(
  rpcPath,
  onSuccess,
  onDiagnosticAdd,
  onDiagnosticRemove,
  onRpcError
) {
  // console.log("init RPC socket");
  // console.log(rpcPath);
  socket = net.createConnection(rpcPath);

  socket.on("connect", () => {
    // console.log("RPC socket connected");

    socket.write(initializePayload);
  });

  socket.on("end", () => {
    console.log("RPC connection disconnected");
  });

  socket.on("error", (err) => {
    if (err.code === "ENOENT") {
      setTimeout(() => {
        init(
          rpcPath,
          onSuccess,
          onDiagnosticAdd,
          onDiagnosticRemove,
          onRpcError
        );
      }, 200);
    } else {
      onRpcError(err);
    }
  });

  socket.on("timeout", () => {
    console.log("RPC connection timeout");
  });

  socket.on("data", (data) => {
    const payloads = parse(data.toString());

    payloads.forEach((payload) => {
      // console.log(util.inspect(payload, {depth: Infinity, colors: true, compact: false}));

      // ((2:id(10:initialize))(6:result(2:ok())))
      // [ { id: [ 'initialize' ], result: [ 'ok', {} ] } ]
      if (payload.id[0] === "initialize" && payload.result[0] === "ok") {
        socket.write(versionsPayload);
      } else if (
        payload.id[0] === "version menu" &&
        payload.result[0] === "ok"
      ) {
        socket.write(pollProgressPayload);
        socket.write(pollDiagnosticsPayload);
      }

      // { id: { poll: [ 'auto', '0' ], i: '0' }, result: [ 'ok', [ 'Some', [ 'success', {} ] ] ] }
      else if (payload.id.poll && payload.id.poll[1] === "0") {
        if (payload.result[1][1][0] === "success") {
          onSuccess();
        }

        socket.write(pollProgressPayload);
      }

      //   result: [ 'ok', [ 'Some', { Add: { directory: '/home/pierre/dev/melange-vite-template', id: '3', loc: { start: { pos_bol: '0', pos_cnum: '11', pos_fname: '/home/pierre/dev/melange-vite-template/src/truc.re', pos_lnum: '1' }, stop: { pos_bol: '0', pos_cnum: '14', pos_fname: '/home/pierre/dev/melange-vite-template/src/truc.re', pos_lnum: '1' } }, message: [ 'Vbox', [ '0', [ 'Box', [ '0', [ 'Verbatim', 'Unbound value asd\nHint: Did you mean asr?' ] ] ] ] ], promotion: {}, related: {}, severity: 'error', targets: {} } } ] ]
      else if (payload.id.poll && payload.id.poll[1] === "1") {
        if (payload.result[1] && payload.result[1][1].Add) {
          onDiagnosticAdd(make_error(payload.result[1][1].Add));
        } else if (payload.result[1] && payload.result[1][1].Remove) {
          onDiagnosticRemove(make_error(payload.result[1][1].Remove));
        }

        socket.write(pollDiagnosticsPayload);
      } else {
        console.log("Unhandled payload");
        console.log(
          util.inspect(payload, {
            depth: Infinity,
            colors: true,
            compact: false,
          })
        );
      }
    });
  });
}

function parse(input) {
  const result = [];
  const stack = [];

  while (input[0]) {
    switch (input[0]) {
      case "(":
        stack.push([]);
        input = input.slice(1);
        break;
      case ")":
        if (stack.length) {
          let top = stack.pop();
          if (
            top.every(function (i) {
              return Array.isArray(i) && i.length === 2;
            })
          ) {
            top = Object.fromEntries(top);
          }
          if (stack.length) {
            var last = stack[stack.length - 1];
            last.push(top);
          } else {
            result.push(top);
          }
          input = input.slice(1);
        } else {
          throw new Error("Syntax Error - unmatched closing paren");
        }
        break;
      default:
        const size = parseInt(input);
        input = input.slice(input.indexOf(":") + 1);
        const top = stack[stack.length - 1];
        top.push(input.slice(0, size));
        input = input.slice(size);
    }
  }

  return result;
}
